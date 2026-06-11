/**
 * server.js
 * Main Express server with MetaMask authentication and role-based dashboards
 * Supports multiple users/accounts with different roles: Manufacturer, Distributor, Pharmacy
 * Uses PostgreSQL for persistent data storage
 */

import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { ethers } from 'ethers';
import { pool, getDbEngine } from './db.js';
import rateLimit from 'express-rate-limit';
import {
    uploadProductData,
    isPinataConfigured,
    getIpfsGatewayUrls,
    fetchIpfsJson,
    verifyIpfsAccessible
} from './ipfs.js';
import {
    CONTRACT_ABI,
    SEPOLIA_CHAIN_ID,
    initializeBlockchainReadOnly,
    getMedicineFromBlockchain,
    getMedicineHistory
} from './blockchain.js';
import {
    issueMedicineCredential,
    issueHandoffCredential,
    verifyCredentialJwt,
    decodeVcClaims
} from './waltid-ssi.js';
import { buildVerifiedMedicineView, vcJwtReference } from './supply-chain-truth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
const PUBLIC_DIR = path.join(__dirname, 'public');

// Čisti URL-ji dashboardov (brez .html)
app.get('/manufacturer', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'manufacturer-dashboard.html')));
app.get('/distributor', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'distributor-dashboard.html')));
app.get('/pharmacy', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'pharmacy-dashboard.html')));
app.get('/manufacturer-dashboard.html', (_req, res) => res.redirect(301, '/manufacturer'));
app.get('/distributor-dashboard.html', (_req, res) => res.redirect(301, '/distributor'));
app.get('/pharmacy-dashboard.html', (_req, res) => res.redirect(301, '/pharmacy'));

app.use(express.static(PUBLIC_DIR));

// ===== RATE LIMITING =====
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
});

// Apply rate limiting to all API endpoints
app.use('/api/', apiLimiter);

// ===== CONFIGURATION =====
const WALT_API = process.env.WALT_ID_API_URL;
const WALT_ISSUER_API = process.env.WALT_ISSUER_API_URL || 'http://issuer-api:7002';
const WALT_VERIFIER_API = process.env.WALT_VERIFIER_API_URL || 'http://verifier-api:7003';
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const PORT = process.env.PORT || 3000;
const SESSION_EXPIRY_HOURS = 168; // 7 days - NOTE: Keep in sync with SQL INTERVAL '7 days'
const API_TIMEOUT_MS = 30000;

// ===== DATABASE — PostgreSQL ali MySQL (glej db.js, APP_DB_ENGINE) =====

// ===== INPUT VALIDATION HELPERS =====
function isValidEthereumAddress(address) {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidRole(role) {
    return ['manufacturer', 'distributor', 'pharmacy'].includes(role.toLowerCase());
}

function sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    return input.trim().substring(0, 255);
}

function generateSecureSessionId() {
    return `sess_${crypto.randomBytes(32).toString('hex')}`;
}

async function getManufacturerAvailableQuantity(medicineId, manufacturerWallet) {
    const result = await pool.query(
        `SELECT m.quantity - COALESCE(SUM(d.quantity), 0) AS available
         FROM medicines m
         LEFT JOIN deliveries d ON d.medicine_id = m.medicine_id
            AND d.source_wallet = $2
            AND d.source_role = 'manufacturer'
         WHERE m.medicine_id = $1 AND m.manufacturer_wallet = $2
         GROUP BY m.quantity`,
        [medicineId, manufacturerWallet]
    );
    return parseInt(result.rows[0]?.available ?? 0, 10);
}

async function getDistributorAvailableQuantity(medicineId, distributorWallet) {
    const result = await pool.query(
        `SELECT
            COALESCE((
                SELECT SUM(quantity) FROM deliveries
                WHERE medicine_id = $1 AND target_wallet = $2
                  AND source_role = 'manufacturer' AND status = 'RECEIVED'
            ), 0) -
            COALESCE((
                SELECT SUM(quantity) FROM deliveries
                WHERE medicine_id = $1 AND source_wallet = $2
                  AND source_role = 'distributor'
                  AND status IN ('IN_TRANSIT', 'DELIVERED')
            ), 0) AS available`,
        [medicineId, distributorWallet]
    );
    return parseInt(result.rows[0]?.available ?? 0, 10);
}

async function getSessionWallet(sessionId) {
    const result = await pool.query(
        'SELECT wallet_address FROM sessions WHERE session_id = $1',
        [sessionId]
    );
    return result.rows[0]?.wallet_address || null;
}

function formatDateOnly(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toISOString().slice(0, 10);
}

function getIpfsLinks(ipfsHash) {
    return getIpfsGatewayUrls(ipfsHash);
}

const ETHERSCAN_BASE = (process.env.ETHERSCAN_BASE_URL || 'https://sepolia.etherscan.io').replace(/\/$/, '');

function getBlockchainExplorerLinks(txHash, extra = {}) {
    const contract = CONTRACT_ADDRESS;
    return {
        network: 'Sepolia',
        explorer: ETHERSCAN_BASE,
        tx: txHash ? `${ETHERSCAN_BASE}/tx/${txHash}` : null,
        contract: contract ? `${ETHERSCAN_BASE}/address/${contract}` : null,
        ...extra
    };
}

async function loadOnChainMedicine(medicineId) {
    if (!ensureBlockchainRead()) {
        return { available: false, error: 'Blockchain ni konfiguriran' };
    }
    try {
        const data = await getMedicineFromBlockchain(medicineId);
        const history = await getMedicineHistory(medicineId);
        return {
            available: true,
            medicine: data,
            history,
            explorer: getBlockchainExplorerLinks(null, {
                manufacturer: data.manufacturer
                    ? `${ETHERSCAN_BASE}/address/${data.manufacturer}`
                    : null
            })
        };
    } catch (error) {
        return { available: false, error: error.message };
    }
}

function getIntegrationConfigStatus() {
    return {
        pinata: {
            configured: isPinataConfigured(),
            apiKeySet: Boolean(process.env.PINATA_API_KEY),
            secretSet: Boolean(process.env.PINATA_SECRET_API_KEY)
        },
        blockchain: {
            rpcSet: Boolean(SEPOLIA_RPC_URL),
            contractSet: Boolean(CONTRACT_ADDRESS),
            signingModel: 'metamask'
        },
        waltId: {
            walletApi: WALT_API || null,
            issuerApi: WALT_ISSUER_API,
            verifierApi: WALT_VERIFIER_API
        }
    };
}

async function pingWaltService(baseUrl, path = '/') {
    try {
        const url = `${String(baseUrl).replace(/\/$/, '')}${path}`;
        const response = await axios.get(url, { timeout: 5000, validateStatus: () => true });
        return { ok: response.status < 500, status: response.status, url };
    } catch (error) {
        return { ok: false, error: error.message, url: baseUrl };
    }
}

function parseStoredVcRecord(vcRaw) {
    if (!vcRaw) return { signed: false, jwt: null, claims: null, error: null };
    try {
        const parsed = typeof vcRaw === 'string' ? JSON.parse(vcRaw) : vcRaw;
        const jwt = parsed.signedJwt || parsed.jwt || (typeof parsed === 'string' && parsed.includes('.') ? parsed : null);
        return {
            signed: Boolean(jwt || parsed.signed === true),
            jwt,
            claims: jwt ? decodeVcClaims(jwt) : null,
            error: parsed.error || null
        };
    } catch {
        if (typeof vcRaw === 'string' && vcRaw.includes('.')) {
            return { signed: true, jwt: vcRaw, claims: decodeVcClaims(vcRaw), error: null };
        }
        return { signed: false, jwt: null, claims: null, error: null };
    }
}

async function userCanAccessMedicine(wallet, role, medicineId) {
    if (role === 'manufacturer') {
        const r = await pool.query(
            'SELECT 1 FROM medicines WHERE medicine_id = $1 AND manufacturer_wallet = $2',
            [medicineId, wallet]
        );
        return r.rows.length > 0;
    }
    if (role === 'distributor') {
        const r = await pool.query(
            `SELECT 1 FROM deliveries
             WHERE medicine_id = $1 AND (source_wallet = $2 OR target_wallet = $2)`,
            [medicineId, wallet]
        );
        return r.rows.length > 0;
    }
    if (role === 'pharmacy') {
        const r = await pool.query(
            `SELECT 1 FROM deliveries
             WHERE medicine_id = $1 AND target_wallet = $2
               AND status IN ('IN_TRANSIT', 'DELIVERED')`,
            [medicineId, wallet]
        );
        return r.rows.length > 0;
    }
    return false;
}

function buildChainHandoffPayload({
    medicineId,
    deliveryId,
    quantity,
    counterpartyWallet,
    counterpartyDid,
    eventType,
    transportJwt,
    newHolderWallet,
    newHolderDid
}) {
    if (!CONTRACT_ADDRESS) {
        return { needsBlockchain: false, skipped: true, reason: 'CONTRACT_ADDRESS ni nastavljen' };
    }
    return {
        needsBlockchain: true,
        payload: {
            medicineId,
            deliveryId,
            quantity,
            counterpartyAddress: counterpartyWallet,
            counterpartyDid: counterpartyDid || '',
            eventType,
            vcRef: vcJwtReference(transportJwt),
            newHolderAddress: newHolderWallet,
            newHolderDid: newHolderDid || ''
        }
    };
}

async function buildMedicineDetailsResponse(medicineId, { viewerWallet, viewerRole, deliveryId = null } = {}) {
    const medicineResult = await pool.query(
        `SELECT m.*, u.company_name AS manufacturer_name
         FROM medicines m
         JOIN users u ON m.manufacturer_wallet = u.wallet_address
         WHERE m.medicine_id = $1`,
        [medicineId]
    );
    if (medicineResult.rows.length === 0) return null;

    const medicine = medicineResult.rows[0];

    const deliveriesResult = await pool.query(
        `SELECT d.*,
                sw.company_name AS source_name, tw.company_name AS target_name
         FROM deliveries d
         LEFT JOIN users sw ON d.source_wallet = sw.wallet_address
         LEFT JOIN users tw ON d.target_wallet = tw.wallet_address
         WHERE d.medicine_id = $1 ORDER BY d.created_at ASC`,
        [medicineId]
    );

    const blockchainReady = Boolean(ensureBlockchainRead());
    const verified = await buildVerifiedMedicineView({
        medicineId,
        dbMedicine: medicine,
        dbDeliveries: deliveriesResult.rows,
        pool,
        blockchainReady,
        viewerRole,
        viewerWallet,
        deliveryId
    });

    const blockchainExplorer = getBlockchainExplorerLinks(verified.txHash, {
        manufacturer: verified.onChain?.medicine?.manufacturer
            ? `${ETHERSCAN_BASE}/address/${verified.onChain.medicine.manufacturer}`
            : null
    });

    return {
        ...verified,
        expiryDate: formatDateOnly(verified.expiryDate),
        ipfsLinks: getIpfsLinks(verified.ipfsHash),
        blockchainExplorer
    };
}

function extractJwtFromVcCredential(vcCredentialRaw) {
    if (!vcCredentialRaw) return null;
    try {
        const parsed = typeof vcCredentialRaw === 'string'
            ? JSON.parse(vcCredentialRaw)
            : vcCredentialRaw;
        if (typeof parsed === 'string' && parsed.includes('.')) {
            return parsed;
        }
        if (parsed.signedJwt) return parsed.signedJwt;
        if (parsed.jwt) return parsed.jwt;
    } catch {
        if (typeof vcCredentialRaw === 'string' && vcCredentialRaw.includes('.')) {
            return vcCredentialRaw;
        }
    }
    return null;
}

function ensureBlockchainRead() {
    if (!SEPOLIA_RPC_URL || !CONTRACT_ADDRESS) {
        return null;
    }
    if (!global.blockchainRead) {
        global.blockchainRead = initializeBlockchainReadOnly(SEPOLIA_RPC_URL, CONTRACT_ADDRESS);
    }
    return global.blockchainRead;
}

const SUPPLY_CHAIN_ACTION_LABELS = {
    CREATED: 'Ustvarjeno',
    SENT_TO_DISTRIBUTOR: 'Poslano distributorju',
    RECEIVED_BY_DISTRIBUTOR: 'Sprejeto pri distributorju',
    FORWARDED_TO_PHARMACY: 'Poslano v lekarno',
    RECEIVED_AT_PHARMACY: 'Sprejeto v lekarni',
    VC_VERIFIED_AT_PHARMACY: 'VC preverjen v lekarni',
    IPFS_VERIFIED_AT_PHARMACY: 'IPFS vsebina preverjena',
    ADDED_TO_DELIVERY: 'Pošiljka ustvarjena (zastarelo)'
};

// ===== DB helpers (MySQL ne vrne rows po INSERT/UPDATE brez RETURNING) =====
async function selectUserBySessionId(sessionId, executor = pool) {
    const result = await executor.query(
        'SELECT * FROM users WHERE session_id = $1',
        [sessionId]
    );
    return result.rows[0] || null;
}

async function selectMedicineByMedicineId(medicineId, executor = pool) {
    const result = await executor.query(
        'SELECT * FROM medicines WHERE medicine_id = $1',
        [medicineId]
    );
    return result.rows[0] || null;
}

async function selectDeliveryByDeliveryId(deliveryId, executor = pool) {
    const result = await executor.query(
        'SELECT * FROM deliveries WHERE delivery_id = $1',
        [deliveryId]
    );
    return result.rows[0] || null;
}

// ===== HELPER: Walt.id API calls =====
function mergeWaltSessionCookie(response, existingCookie = null) {
    const setCookie = response.headers?.['set-cookie'];
    if (!setCookie?.length) return existingCookie;
    return setCookie.map((c) => c.split(';')[0]).join('; ');
}

function isUnknownWaltUserError(error) {
    const message = error?.response?.data?.message || '';
    return error?.response?.status === 401 && /Unknown user/i.test(String(message));
}

function toWaltAuthError(error, fallbackMessage) {
    const status = error?.response?.status;
    const data = error?.response?.data;
    const detail = typeof data === 'string'
        ? data
        : (data?.message || data?.error || error?.message);
    const message = isUnknownWaltUserError(error)
        ? 'Walt.id račun ne obstaja (verjetno ponoven zagon wallet-api baze). Prijava bo poskusila ponovno ustvariti račun.'
        : (status === 401 || status === 403
            ? 'Napačen Walt.id email ali geslo'
            : (detail || fallbackMessage));
    const err = new Error(message);
    err.statusCode = status && status < 500 ? status : 500;
    return err;
}

async function registerWaltIdAccount(userRecord, waltEmail, password) {
    await callWaltAPI('POST', '/auth/register', {
        type: 'email',
        name: userRecord.company_name,
        email: waltEmail,
        password
    });
    console.log(`[Walt.id] Nov račun: ${waltEmail}`);
}

async function callWaltAPI(method, endpoint, data = null, sessionCookie = null) {
    const config = {
        method,
        url: `${WALT_API}${endpoint}`,
        headers: { 'Content-Type': 'application/json' },
        timeout: API_TIMEOUT_MS,
        validateStatus: () => true
    };

    if (sessionCookie) {
        config.headers.Cookie = sessionCookie;
    }
    if (data) {
        config.data = data;
    }

    const response = await axios(config);

    if (response.status >= 400) {
        const err = new Error(
            `Walt.id ${method} ${endpoint} → ${response.status}: ${
                JSON.stringify(response.data)?.slice(0, 200)
            }`
        );
        err.response = response;
        console.error(`[Walt.id ERROR] ${err.message}`);
        throw err;
    }

    return {
        data: response.data,
        cookie: mergeWaltSessionCookie(response, sessionCookie)
    };
}

/**
 * Prijava/registracija v Walt.id + pridobitev DID, wallet_id in session cookie.
 */
async function establishWaltIdSession(userRecord, waltEmail, password, { allowRegister = false } = {}) {
    const normalizedWaltEmail = sanitizeInput(waltEmail).toLowerCase();

    if (!isValidEmail(normalizedWaltEmail)) {
        const err = new Error('Neveljaven Walt.id email');
        err.statusCode = 400;
        throw err;
    }

    if (!password || password.length < 8) {
        const err = new Error('Geslo mora imeti vsaj 8 znakov');
        err.statusCode = 400;
        throw err;
    }

    if (userRecord.walt_email && userRecord.walt_email.toLowerCase() !== normalizedWaltEmail) {
        const err = new Error('Walt.id email se ne ujema z registracijo te denarnice');
        err.statusCode = 401;
        throw err;
    }

    const hasWaltProfile = Boolean(userRecord.did && userRecord.wallet_id);

    if (allowRegister && !hasWaltProfile) {
        try {
            await registerWaltIdAccount(userRecord, normalizedWaltEmail, password);
        } catch (registerError) {
            if (registerError?.response?.status === 409) {
                console.log('[Walt.id] Račun že obstaja, nadaljujem s prijavo...');
            } else {
                throw toWaltAuthError(registerError, 'Registracija v Walt.id ni uspela');
            }
        }
    }

    let loginResult;
    try {
        loginResult = await callWaltAPI('POST', '/auth/login', {
            type: 'email',
            email: normalizedWaltEmail,
            password
        });
    } catch (loginError) {
        if (isUnknownWaltUserError(loginError)) {
            console.warn(
                `[Walt.id] Račun ${normalizedWaltEmail} manjka v wallet-api `
                + '(ponoven zagon PostgreSQL). Ponovna registracija...'
            );
            try {
                await registerWaltIdAccount(userRecord, normalizedWaltEmail, password);
            } catch (registerError) {
                if (registerError?.response?.status !== 409) {
                    throw toWaltAuthError(registerError, 'Registracija v Walt.id ni uspela');
                }
            }
            loginResult = await callWaltAPI('POST', '/auth/login', {
                type: 'email',
                email: normalizedWaltEmail,
                password
            });
        } else {
            throw toWaltAuthError(loginError, 'Prijava v Walt.id ni uspela');
        }
    }

    let sessionCookie = loginResult.cookie;

    const walletsResult = await callWaltAPI('GET', '/wallet/accounts/wallets', null, sessionCookie);
    sessionCookie = walletsResult.cookie;
    const walletId = walletsResult.data?.wallets?.[0]?.id;
    if (!walletId) {
        throw new Error('Walt.id wallet ni bil najden');
    }

    const didsResult = await callWaltAPI('GET', `/wallet/${walletId}/dids`, null, sessionCookie);
    sessionCookie = didsResult.cookie;
    const did = extractDidValue(didsResult.data);
    if (!did) {
        throw new Error('Walt.id DID ni bil najden');
    }

    return { did, walletId, sessionCookie, waltEmail: normalizedWaltEmail };
}

function formatAuthUserResponse(userRecord, walt = {}) {
    return {
        walletAddress: userRecord.wallet_address,
        role: userRecord.role,
        companyName: userRecord.company_name,
        email: userRecord.email,
        waltEmail: walt.waltEmail || userRecord.walt_email || null,
        did: walt.did || userRecord.did,
        walletId: walt.walletId || userRecord.wallet_id,
        hasWaltSession: Boolean(walt.sessionCookie || userRecord.walt_api_cookie)
    };
}

// ===== HELPER: Extract DID from Walt.id response =====
function extractDidValue(response) {
    if (!response) return null;
    if (typeof response === 'string') return response;
    if (response.did) return response.did;
    if (response.id && typeof response.id === 'string' && response.id.startsWith('did:')) return response.id;
    if (response.dids && response.dids.length > 0) {
        const firstDid = response.dids[0];
        return typeof firstDid === 'string' ? firstDid : (firstDid.did || firstDid.id || null);
    }
    if (Array.isArray(response) && response.length > 0) {
        const firstItem = response[0];
        return typeof firstItem === 'string' ? firstItem : (firstItem?.did || firstItem?.id || null);
    }
    return null;
}

// ===== HELPER: Validate and clean session =====
async function isSessionValid(sessionId) {
    try {
        const result = await pool.query(
            'SELECT * FROM sessions WHERE session_id = $1 AND expires_at > CURRENT_TIMESTAMP',
            [sessionId]
        );
        return result.rows.length > 0;
    } catch (error) {
        console.error('Session validation error:', error.message);
        return false;
    }
}

// ===== ENDPOINTS =====

// 1. METAMASK CONNECTION - User connects their MetaMask wallet
app.post('/api/auth/connect-metamask', async (req, res) => {
    try {
        const { walletAddress, role, companyName, email } = req.body;

        // Input validation
        if (!walletAddress || !role || !companyName || !email) {
            return res.status(400).json({ error: 'Missing required fields: walletAddress, role, companyName, email' });
        }

        if (!isValidEthereumAddress(walletAddress)) {
            return res.status(400).json({ error: 'Invalid wallet address format' });
        }

        if (!isValidRole(role)) {
            return res.status(400).json({ error: 'Invalid role. Must be: manufacturer, distributor, or pharmacy' });
        }

        if (!isValidEmail(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        const normalizedAddress = walletAddress.toLowerCase();
        const sanitizedCompanyName = sanitizeInput(companyName);
        const sanitizedEmail = sanitizeInput(email);

        // Check if wallet already connected
        const existingUser = await pool.query('SELECT * FROM users WHERE wallet_address = $1', [normalizedAddress]);
        
        if (existingUser.rows.length > 0) {
            const user = existingUser.rows[0];
            const sessionId = generateSecureSessionId();

            await pool.query(
                'UPDATE users SET session_id = $1, last_active = CURRENT_TIMESTAMP WHERE wallet_address = $2',
                [sessionId, normalizedAddress]
            );
            await pool.query(
                `INSERT INTO sessions (session_id, wallet_address, expires_at)
                 VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '7 days')`,
                [sessionId, normalizedAddress]
            );

            const fullyRegistered = Boolean(user.did && user.wallet_id);

            return res.status(200).json({
                success: true,
                message: fullyRegistered
                    ? 'Denarnica je že registrirana — uporabite prijavo'
                    : 'Dokončajte Walt.id registracijo',
                alreadyRegistered: fullyRegistered,
                completingWalt: !fullyRegistered,
                sessionId,
                user: {
                    walletAddress: user.wallet_address,
                    role: user.role,
                    companyName: user.company_name,
                    email: user.email,
                    waltEmail: user.walt_email,
                    did: user.did,
                    walletId: user.wallet_id
                }
            });
        }

        // Create new user session with cryptographically secure random ID
        const sessionId = generateSecureSessionId();
        
        await pool.query(
            `INSERT INTO users 
             (wallet_address, role, email, company_name, session_id) 
             VALUES ($1, $2, $3, $4, $5)`,
            [normalizedAddress, role.toLowerCase(), sanitizedEmail, sanitizedCompanyName, sessionId]
        );

        const userRecord = await selectUserBySessionId(sessionId);
        if (!userRecord) {
            return res.status(500).json({ error: 'Uporabnika ni mogoče prebrati po vnosu' });
        }
        
        // Create session record
        await pool.query(
            `INSERT INTO sessions (session_id, wallet_address, expires_at)
             VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '7 days')`,
            [sessionId, normalizedAddress]
        );

        res.json({
            success: true,
            message: 'MetaMask connected successfully',
            sessionId,
            user: {
                walletAddress: userRecord.wallet_address,
                role: userRecord.role,
                companyName: userRecord.company_name,
                email: userRecord.email
            }
        });
    } catch (error) {
        console.error('MetaMask connection error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Check if wallet is already registered (for login vs registration flow)
app.get('/api/auth/check-wallet', async (req, res) => {
    try {
        const { walletAddress } = req.query;

        if (!walletAddress || !isValidEthereumAddress(walletAddress)) {
            return res.status(400).json({ error: 'Invalid wallet address' });
        }

        const normalizedAddress = walletAddress.toLowerCase();
        const userResult = await pool.query(
            `SELECT wallet_address, role, company_name, email, did, wallet_id, walt_email, walt_api_cookie
             FROM users WHERE wallet_address = $1`,
            [normalizedAddress]
        );

        if (userResult.rows.length === 0) {
            return res.json({ registered: false });
        }

        const user = userResult.rows[0];
        res.json({
            registered: true,
            hasWaltId: !!(user.did && user.wallet_id),
            hasWaltSession: Boolean(user.walt_api_cookie),
            user: {
                walletAddress: user.wallet_address,
                role: user.role,
                companyName: user.company_name,
                email: user.email,
                waltEmail: user.walt_email,
                did: user.did,
                walletId: user.wallet_id
            }
        });
    } catch (error) {
        console.error('Check wallet error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 2. WALT.ID — registracija ali osvežitev seje (email + geslo, ki ju vnese uporabnik)
app.post('/api/auth/register-walt', async (req, res) => {
    try {
        const { sessionId, waltEmail, password } = req.body;

        if (!sessionId) {
            return res.status(401).json({ error: 'Manjka seja — najprej povežite MetaMask' });
        }

        if (!(await isSessionValid(sessionId))) {
            return res.status(401).json({ error: 'Seja je potekla — ponovno se registrirajte' });
        }

        const userResult = await pool.query('SELECT * FROM users WHERE session_id = $1', [sessionId]);
        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Uporabnik ni najden' });
        }

        const userRecord = userResult.rows[0];
        const resolvedWaltEmail = waltEmail || userRecord.walt_email;

        if (!resolvedWaltEmail) {
            return res.status(400).json({ error: 'Walt.id email je obvezen' });
        }

        const allowRegister = !(userRecord.did && userRecord.wallet_id);
        console.log(`[Walt.id] ${allowRegister ? 'Registracija' : 'Osvežitev seje'}: ${resolvedWaltEmail}`);

        const walt = await establishWaltIdSession(userRecord, resolvedWaltEmail, password, { allowRegister });

        await pool.query(
            `UPDATE users
             SET did = $1, wallet_id = $2, walt_api_cookie = $3, walt_email = $4,
                 walt_id_registered_at = CURRENT_TIMESTAMP, last_active = CURRENT_TIMESTAMP
             WHERE session_id = $5`,
            [walt.did, walt.walletId, walt.sessionCookie, walt.waltEmail, sessionId]
        );

        await pool.query(
            'UPDATE sessions SET last_activity = CURRENT_TIMESTAMP WHERE session_id = $1',
            [sessionId]
        );

        const updatedUserRecord = await selectUserBySessionId(sessionId);
        if (!updatedUserRecord) {
            return res.status(500).json({ error: 'Uporabnika ni mogoče posodobiti po Walt.id' });
        }

        console.log(`✓ Walt.id OK: ${walt.waltEmail} | DID: ${walt.did?.slice(0, 40)}...`);

        res.json({
            success: true,
            message: allowRegister
                ? 'Registracija v Walt.id uspešna'
                : 'Walt.id seja osvežena',
            user: formatAuthUserResponse(updatedUserRecord, walt),
            needsOnChainRegistration: Boolean(CONTRACT_ADDRESS && updatedUserRecord.did),
            onChainRegistration: {
                did: updatedUserRecord.did,
                role: updatedUserRecord.role
            }
        });
    } catch (error) {
        console.error('Walt.id registration error:', error.message);
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

// 3. GET USER INFO - Retrieve current session user info
app.get('/api/auth/user-info', async (req, res) => {
    try {
        const { sessionId } = req.query;

        if (!sessionId) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }

        // Validate session
        if (!(await isSessionValid(sessionId))) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }

        // Fetch from database
        const userResult = await pool.query(
            'SELECT * FROM users WHERE session_id = $1',
            [sessionId]
        );

        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }

        const userRecord = userResult.rows[0];
        
        // Update last activity
        await pool.query(
            'UPDATE sessions SET last_activity = CURRENT_TIMESTAMP WHERE session_id = $1',
            [sessionId]
        );

        res.json({
            success: true,
            user: {
                walletAddress: userRecord.wallet_address,
                role: userRecord.role,
                companyName: userRecord.company_name,
                email: userRecord.email,
                did: userRecord.did,
                walletId: userRecord.wallet_id,
                waltEmail: userRecord.walt_email,
                hasWaltSession: Boolean(userRecord.walt_api_cookie),
                walletConnectedAt: userRecord.wallet_connected_at,
                waltIdRegisteredAt: userRecord.walt_id_registered_at
            }
        });
    } catch (error) {
        console.error('Get user info error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 4. LOGOUT - Destroy session
app.post('/api/auth/logout', async (req, res) => {
    try {
        const { sessionId } = req.body;

        if (sessionId) {
            // Delete session from database
            await pool.query('DELETE FROM sessions WHERE session_id = $1', [sessionId]);
        }

        res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 5. VALIDATE SESSION - Check if session is still valid
app.get('/api/auth/validate-session', async (req, res) => {
    try {
        const { sessionId } = req.query;

        if (!sessionId) {
            return res.status(401).json({ error: 'Invalid or expired session', valid: false });
        }

        const isValid = await isSessionValid(sessionId);
        
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid or expired session', valid: false });
        }

        res.json({ valid: true });
    } catch (error) {
        console.error('Session validation error:', error.message);
        res.status(500).json({ error: error.message, valid: false });
    }
});

// ===== BLOCKCHAIN (MetaMask podpis v brskalniku) =====

app.get('/api/blockchain/config', (req, res) => {
    if (!CONTRACT_ADDRESS) {
        return res.status(503).json({ success: false, error: 'CONTRACT_ADDRESS ni nastavljen v src/.env' });
    }
    res.json({
        success: true,
        contractAddress: CONTRACT_ADDRESS,
        chainId: SEPOLIA_CHAIN_ID,
        network: 'Sepolia',
        signingModel: 'metamask',
        abi: CONTRACT_ABI,
        explorer: ETHERSCAN_BASE
    });
});

app.post('/api/blockchain/confirm', async (req, res) => {
    try {
        const {
            sessionId,
            type,
            txHash,
            medicineId,
            deliveryId,
            historyAction
        } = req.body;

        if (!sessionId || !type || !txHash) {
            return res.status(400).json({ error: 'Manjkajo sessionId, type ali txHash' });
        }

        if (!(await isSessionValid(sessionId))) {
            return res.status(401).json({ error: 'Neveljavna seja' });
        }

        const userResult = await pool.query(
            'SELECT * FROM users WHERE session_id = $1',
            [sessionId]
        );
        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Uporabnik ni najden' });
        }
        const user = userResult.rows[0];

        if (type === 'register_user') {
            return res.json({
                success: true,
                message: 'Uporabnik registriran na verigi',
                txHash
            });
        }

        if (type === 'register_medicine') {
            if (!medicineId) {
                return res.status(400).json({ error: 'Manjka medicineId' });
            }
            const med = await pool.query(
                'SELECT * FROM medicines WHERE medicine_id = $1 AND manufacturer_wallet = $2',
                [medicineId, user.wallet_address]
            );
            if (med.rows.length === 0) {
                return res.status(403).json({ error: 'Zdravilo ni najdeno ali nimate dostopa' });
            }
            await pool.query(
                `UPDATE medicines SET blockchain_tx_hash = $1, blockchain_status = $2 WHERE medicine_id = $3`,
                [txHash, 'MANUFACTURED', medicineId]
            );
            await pool.query(
                `INSERT INTO supply_chain_history (medicine_id, action, actor_wallet, actor_role, actor_did, blockchain_tx_hash)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [medicineId, 'BLOCKCHAIN_REGISTERED', user.wallet_address, user.role, user.did, txHash]
            );
            return res.json({
                success: true,
                message: 'Zdravilo registrirano na verigi',
                txHash,
                blockchainExplorer: getBlockchainExplorerLinks(txHash)
            });
        }

        if (type === 'handoff') {
            if (!medicineId || !deliveryId) {
                return res.status(400).json({ error: 'Manjkata medicineId in deliveryId' });
            }
            const action = historyAction || 'HANDOFF_ON_CHAIN';
            await pool.query(
                `UPDATE deliveries SET blockchain_tx_hash = $1 WHERE delivery_id = $2`,
                [txHash, deliveryId]
            );
            await pool.query(
                `INSERT INTO supply_chain_history (medicine_id, delivery_id, action, actor_wallet, actor_role, actor_did, blockchain_tx_hash)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [medicineId, deliveryId, action, user.wallet_address, user.role, user.did, txHash]
            );
            return res.json({
                success: true,
                message: 'Handoff zabeležen na verigi',
                txHash,
                blockchainExplorer: getBlockchainExplorerLinks(txHash)
            });
        }

        return res.status(400).json({ error: `Neznan tip: ${type}` });
    } catch (error) {
        console.error('Blockchain confirm error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ===== MEDICINE MANAGEMENT ENDPOINTS =====

// System / Walt.id + IPFS + blockchain configuration status
app.get('/api/system/status', async (req, res) => {
    try {
        const config = getIntegrationConfigStatus();
        const [walletPing, issuerPing, verifierPing] = await Promise.all([
            WALT_API ? pingWaltService(WALT_API, '/auth/session') : Promise.resolve({ ok: false, skipped: true }),
            pingWaltService(WALT_ISSUER_API, '/'),
            pingWaltService(WALT_VERIFIER_API, '/')
        ]);

        const blockchainRuntime = {
            configured: Boolean(config.blockchain.rpcSet && config.blockchain.contractSet),
            signingModel: 'metamask',
            chainId: SEPOLIA_CHAIN_ID,
            contract: CONTRACT_ADDRESS || null,
            hint: 'Vsak udeleženec podpiše TX v MetaMask (Sepolia ETH)'
        };

        res.json({
            success: true,
            dbEngine: getDbEngine(),
            config,
            services: {
                walletApi: walletPing,
                issuerApi: issuerPing,
                verifierApi: verifierPing
            },
            blockchain: blockchainRuntime,
            ready: {
                ipfs: config.pinata.configured,
                blockchain: blockchainRuntime.configured,
                issuer: issuerPing.ok,
                verifier: verifierPing.ok
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/medicines/templates', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, template_name, template_description FROM medicine_templates');
        res.json({
            success: true,
            templates: result.rows
        });
    } catch (error) {
        console.error('Get templates error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 7. CREATE MEDICINE - Manufacturer creates a medicine
app.post('/api/medicines/create', async (req, res) => {
    const client = await pool.connect();
    try {
        const { sessionId, medicineName, quantity, batchNumber, expiryDate, description, targetPharmacyName, targetPharmacyWallet } = req.body;

        if (!sessionId || !medicineName || !quantity || !batchNumber || !expiryDate) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Validate session and get user
        const userResult = await client.query(
            'SELECT * FROM users WHERE session_id = $1 AND role = $2',
            [sessionId, 'manufacturer']
        );

        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Unauthorized or invalid session' });
        }

        const user = userResult.rows[0];

        if (!user.did) {
            return res.status(400).json({
                error: 'Račun ni popolnoma registriran v Walt.id. Prosimo dokončajte registracijo na domači strani.'
            });
        }

        if (!user.walt_api_cookie) {
            return res.status(400).json({
                error: 'Manjka Walt.id seja za podpis VC. Na domači strani se ponovno prijavite z MetaMask in istim geslom (Registracija v Walt.id).'
            });
        }

        const medicineId = `MED-${crypto.randomUUID()}`;

        // Start transaction
        await client.query('BEGIN');

        // 1. Insert medicine record
        await client.query(
            `INSERT INTO medicines 
             (medicine_id, name, description, quantity, batch_number, expiry_date, 
              manufacturer_wallet, manufacturer_did, manufacturer_name, blockchain_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [medicineId, medicineName, description || '', quantity, batchNumber, expiryDate,
             user.wallet_address, user.did, user.company_name, 'PENDING']
        );

        const medicine = await selectMedicineByMedicineId(medicineId, client);
        if (!medicine) {
            throw new Error('Zdravila ni mogoče prebrati po vnosu');
        }

        // 2. Issue signed VC via Walt.id Issuer API
        let vcCredential = null;
        let vcJwt = null;
        let vcSigned = false;
        try {
            const issued = await issueMedicineCredential(
                {
                    medicineId,
                    name: medicineName,
                    batchNumber,
                    quantity,
                    expiryDate,
                    description: description || ''
                },
                user,
                { walletId: user.wallet_id, waltCookie: user.walt_api_cookie }
            );
            vcJwt = issued.jwt;
            vcCredential = { signedJwt: vcJwt, issuerDid: issued.issuerDid, signed: true };
            vcSigned = true;
            console.log(`✓ Medicine VC issued via Walt.id Issuer`);
        } catch (vcError) {
            console.error(`✗ Walt.id VC issuance failed: ${vcError.message}`);
            vcCredential = {
                '@context': ['https://www.w3.org/2018/credentials/v1'],
                type: ['VerifiableCredential', 'MedicineCredential'],
                issuer: user.did,
                issuanceDate: new Date().toISOString(),
                credentialSubject: {
                    medicineId,
                    name: medicineName,
                    batchNumber,
                    quantity,
                    expiryDate,
                    manufacturer: user.company_name,
                    manufacturerDID: user.did,
                    description: description || ''
                },
                signed: false,
                error: vcError.message
            };
        }

        // 3. Upload to IPFS (Pinata) — vključi podatke + referenco na podpisani VC
        let ipfsHash = null;
        let ipfsError = null;
        if (!isPinataConfigured()) {
            ipfsError = 'Pinata ni konfiguriran (PINATA_API_KEY / PINATA_SECRET_API_KEY v src/.env)';
            console.error(`✗ ${ipfsError}`);
        } else {
            try {
                ipfsHash = await uploadProductData({
                    medicineId,
                    name: medicineName,
                    batchNumber,
                    quantity,
                    expiryDate,
                    eventType: 'MANUFACTURED',
                    eventTimestamp: new Date().toISOString(),
                    creatorRole: 'manufacturer',
                    creatorName: user.company_name,
                    creatorWallet: user.wallet_address,
                    creatorDID: user.did,
                    manufacturer: user.company_name,
                    manufacturerDID: user.did,
                    description: description || '',
                    serialNumber: medicineId,
                    vcSigned,
                    issuerDid: vcCredential?.issuerDid || null,
                    credentialType: 'MedicineCredential',
                    uploadedAt: new Date().toISOString()
                });
                console.log(`✓ Medicine uploaded to IPFS: ${ipfsHash}`);
            } catch (error) {
                ipfsError = error.message;
                console.error(`✗ IPFS upload failed: ${error.message}`);
            }
        }

        // 4. Update medicine with IPFS + VC (blockchain = MetaMask v brskalniku)
        await client.query(
            `UPDATE medicines 
             SET ipfs_hash = $1, blockchain_status = $2, vc_credential = $3
             WHERE medicine_id = $4`,
            [ipfsHash, ipfsHash && CONTRACT_ADDRESS ? 'PENDING' : 'MANUFACTURED', JSON.stringify(vcCredential), medicineId]
        );

        // 5. Log to supply chain history
        await client.query(
            `INSERT INTO supply_chain_history (medicine_id, action, actor_wallet, actor_role, actor_did, details)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [medicineId, 'CREATED', user.wallet_address, 'manufacturer', user.did,
             JSON.stringify({ medicineName, batchNumber, quantity, targetPharmacyName })]
        );

        await client.query('COMMIT');

        const warnings = [];
        if (!vcSigned) warnings.push(`VC: ${vcCredential?.error || 'podpis prek Issuer API ni uspel'}`);
        if (!ipfsHash) warnings.push(`IPFS: ${ipfsError || 'upload ni uspel'}`);
        const needsBlockchain = Boolean(ipfsHash && CONTRACT_ADDRESS);
        if (needsBlockchain) {
            warnings.push('Blockchain: potrdite registerMedicine v MetaMask (Sepolia)');
        } else if (!CONTRACT_ADDRESS) {
            warnings.push('Blockchain: CONTRACT_ADDRESS ni nastavljen');
        }

        const fullyIntegrated = Boolean(ipfsHash && vcSigned && !needsBlockchain);

        res.json({
            success: true,
            fullyIntegrated,
            needsBlockchain,
            message: needsBlockchain
                ? 'Zdravilo pripravljeno — potrdite registracijo v MetaMask'
                : (fullyIntegrated ? 'Zdravilo ustvarjeno (Walt.id VC + IPFS)' : 'Zdravilo shranjeno v bazi, nekateri koraki niso uspeli'),
            warnings,
            medicine: {
                medicineId,
                name: medicineName,
                batchNumber,
                quantity,
                expiryDate: formatDateOnly(expiryDate),
                ipfsHash,
                ipfsError,
                ipfsLinks: getIpfsLinks(ipfsHash),
                blockchainTxHash: null,
                blockchainStatus: needsBlockchain ? 'PENDING' : 'MANUFACTURED',
                blockchainExplorer: getBlockchainExplorerLinks(null),
                vcSigned,
                targetPharmacyName
            }
        });
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('Rollback error:', rollbackError.message);
        }
        console.error('Medicine creation error:', error.message);
        res.status(500).json({ error: error.message });
    } finally {
        client.release();
    }
});

// 8. SEND TO DISTRIBUTOR - Manufacturer ships medicine to distributor
app.post('/api/medicines/add-to-delivery', async (req, res) => {
    try {
        const { sessionId, medicineId, quantity, targetDistributorName, targetDistributorWallet } = req.body;

        if (!sessionId || !medicineId || !quantity || !targetDistributorWallet) {
            return res.status(400).json({ error: 'Manjkajo obvezna polja (zdravilo, količina, distributor)' });
        }

        const userResult = await pool.query(
            'SELECT * FROM users WHERE session_id = $1 AND role = $2',
            [sessionId, 'manufacturer']
        );

        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Unauthorized or invalid session' });
        }

        const manufacturer = userResult.rows[0];

        const distributorResult = await pool.query(
            'SELECT * FROM users WHERE wallet_address = $1 AND role = $2',
            [targetDistributorWallet, 'distributor']
        );

        if (distributorResult.rows.length === 0) {
            return res.status(404).json({ error: 'Distributor ni registriran' });
        }

        const medicineResult = await pool.query(
            'SELECT * FROM medicines WHERE medicine_id = $1 AND manufacturer_wallet = $2',
            [medicineId, manufacturer.wallet_address]
        );

        if (medicineResult.rows.length === 0) {
            return res.status(404).json({ error: 'Medicine not found' });
        }

        const medicine = medicineResult.rows[0];
        const available = await getManufacturerAvailableQuantity(medicineId, manufacturer.wallet_address);

        if (quantity > available) {
            return res.status(400).json({ error: `Na voljo je samo ${available} enot` });
        }

        const deliveryId = `DELIVERY-${crypto.randomUUID()}`;
        const distributor = distributorResult.rows[0];
        const distributorName = targetDistributorName || distributor.company_name;

        if (!manufacturer.walt_api_cookie) {
            return res.status(400).json({
                error: 'Manjka Walt.id seja. Ponovno se prijavite na domači strani.'
            });
        }

        let transportVc = null;
        try {
            if (manufacturer.did) {
                const issued = await issueHandoffCredential({
                    delivery: { delivery_id: deliveryId, quantity },
                    medicine,
                    sender: manufacturer,
                    recipient: distributor,
                    eventType: 'SENT_TO_DISTRIBUTOR',
                    walletOpts: { walletId: manufacturer.wallet_id, waltCookie: manufacturer.walt_api_cookie }
                });
                transportVc = JSON.stringify({ signedJwt: issued.jwt, issuerDid: issued.issuerDid, signed: true, claims: decodeVcClaims(issued.jwt) });
                console.log(`✓ Handoff VC (→ distributor) ${deliveryId}`);
            }
        } catch (vcError) {
            console.error(`✗ Handoff VC failed: ${vcError.message}`);
            transportVc = JSON.stringify({ signed: false, error: vcError.message });
        }

        await pool.query(
            `INSERT INTO deliveries
             (delivery_id, medicine_id, source_wallet, source_role, target_wallet, target_role,
              target_pharmacy_name, quantity, status, transport_vc_credential)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [deliveryId, medicineId, manufacturer.wallet_address, 'manufacturer',
             targetDistributorWallet, 'distributor', distributorName, quantity, 'PENDING', transportVc]
        );

        await pool.query(
            `INSERT INTO supply_chain_history (medicine_id, delivery_id, action, actor_wallet, actor_role, actor_did, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [medicineId, deliveryId, 'SENT_TO_DISTRIBUTOR', manufacturer.wallet_address, 'manufacturer',
             manufacturer.did, JSON.stringify({
                 quantity,
                 targetDistributorName: distributorName,
                 transportVcIssued: (() => {
                     try { return Boolean(JSON.parse(transportVc || '{}').signedJwt); } catch { return false; }
                 })()
             })]
        );

        const transportJwt = extractJwtFromVcCredential(transportVc);
        const chainHandoff = buildChainHandoffPayload({
            medicineId,
            deliveryId,
            quantity,
            counterpartyWallet: targetDistributorWallet,
            counterpartyDid: distributor.did,
            eventType: 'SENT_TO_DISTRIBUTOR',
            transportJwt,
            newHolderWallet: manufacturer.wallet_address,
            newHolderDid: manufacturer.did
        });

        res.json({
            success: true,
            message: chainHandoff.needsBlockchain
                ? 'Pošiljka pripravljena — potrdite handoff v MetaMask'
                : 'Zdravilo poslano distributorju',
            delivery: {
                deliveryId,
                medicineId,
                quantity,
                targetDistributorName: distributorName,
                status: 'PENDING',
                transportVcIssued: (() => {
                    try { return Boolean(JSON.parse(transportVc || '{}').signedJwt); } catch { return false; }
                })(),
                chainTxHash: null
            },
            chainHandoff
        });
    } catch (error) {
        console.error('Send to distributor error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 9. GET MANUFACTURER MEDICINES - Get all medicines created by manufacturer
app.get('/api/medicines/my-medicines', async (req, res) => {
    try {
        const { sessionId } = req.query;

        if (!sessionId) {
            return res.status(401).json({ error: 'Invalid session' });
        }

        const userResult = await pool.query(
            'SELECT * FROM users WHERE session_id = $1 AND role = $2',
            [sessionId, 'manufacturer']
        );

        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const manufacturer = userResult.rows[0];

        const medicinesResult = await pool.query(
            `SELECT m.*,
                    COALESCE(SUM(d.quantity), 0) AS shipped_quantity,
                    m.quantity - COALESCE(SUM(d.quantity), 0) AS available_quantity,
                    COALESCE(SUM(CASE WHEN d.status = 'PENDING' THEN d.quantity ELSE 0 END), 0) AS pending_quantity,
                    COALESCE(SUM(CASE WHEN d.status = 'RECEIVED' THEN d.quantity ELSE 0 END), 0) AS at_distributor_quantity
             FROM medicines m
             LEFT JOIN deliveries d ON m.medicine_id = d.medicine_id
                AND d.source_wallet = m.manufacturer_wallet
                AND d.source_role = 'manufacturer'
             WHERE m.manufacturer_wallet = $1 AND m.is_active = TRUE
             GROUP BY m.id
             ORDER BY m.created_at DESC`,
            [manufacturer.wallet_address]
        );

        const medicines = medicinesResult.rows.map(row => {
            const available = parseInt(row.available_quantity ?? 0, 10);
            const pending = parseInt(row.pending_quantity ?? 0, 10);
            const atDist = parseInt(row.at_distributor_quantity ?? 0, 10);
            const parts = [];
            if (available > 0) parts.push(`${available} na zalogi`);
            if (pending > 0) parts.push(`${pending} čaka prevzem`);
            if (atDist > 0) parts.push(`${atDist} pri distributorju`);
            return {
                ...row,
                stock_status_label: parts.length ? parts.join(' · ') : 'Vse poslano',
                ipfsLinks: getIpfsLinks(row.ipfs_hash),
                vcSigned: Boolean(extractJwtFromVcCredential(row.vc_credential))
            };
        });

        res.json({
            success: true,
            medicines
        });
    } catch (error) {
        console.error('Get medicines error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// IPFS preview — preberi JSON zdravila prek javnih gatewayov
app.get('/api/medicines/:medicineId/ipfs-data', async (req, res) => {
    try {
        const { sessionId } = req.query;
        const { medicineId } = req.params;

        if (!sessionId) {
            return res.status(401).json({ error: 'Invalid session' });
        }

        const userResult = await pool.query(
            'SELECT wallet_address, role FROM users WHERE session_id = $1',
            [sessionId]
        );
        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const medicineResult = await pool.query(
            'SELECT * FROM medicines WHERE medicine_id = $1',
            [medicineId]
        );
        if (medicineResult.rows.length === 0) {
            return res.status(404).json({ error: 'Medicine not found' });
        }

        const medicine = medicineResult.rows[0];
        const user = userResult.rows[0];

        if (user.role === 'manufacturer' && medicine.manufacturer_wallet !== user.wallet_address) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        if (!medicine.ipfs_hash) {
            return res.status(404).json({
                error: 'IPFS hash ni shranjen za to zdravilo',
                hint: 'Ustvarite zdravilo znova ali preverite Pinata ključe (GET /api/system/status)'
            });
        }

        const ipfsLinks = getIpfsLinks(medicine.ipfs_hash);
        const accessibility = await verifyIpfsAccessible(medicine.ipfs_hash);
        let ipfsDocument = null;
        if (accessibility.accessible) {
            const fetched = await fetchIpfsJson(medicine.ipfs_hash);
            ipfsDocument = fetched.data;
        }

        res.json({
            success: true,
            medicineId,
            ipfsHash: medicine.ipfs_hash,
            ipfsLinks,
            accessibility,
            document: ipfsDocument
        });
    } catch (error) {
        console.error('IPFS data error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Podatki zdravila direktno s pametne pogodbe + Etherscan povezave
app.get('/api/medicines/:medicineId/blockchain', async (req, res) => {
    try {
        const { sessionId } = req.query;
        const { medicineId } = req.params;

        if (!sessionId) {
            return res.status(401).json({ error: 'Invalid session' });
        }
        if (!(await isSessionValid(sessionId))) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }

        const medicineResult = await pool.query(
            'SELECT medicine_id, blockchain_tx_hash, ipfs_hash, blockchain_status FROM medicines WHERE medicine_id = $1',
            [medicineId]
        );
        if (medicineResult.rows.length === 0) {
            return res.status(404).json({ error: 'Medicine not found' });
        }

        const row = medicineResult.rows[0];
        const onChain = await loadOnChainMedicine(medicineId);

        res.json({
            success: true,
            medicineId,
            db: {
                txHash: row.blockchain_tx_hash,
                ipfsHash: row.ipfs_hash,
                status: row.blockchain_status
            },
            blockchainExplorer: getBlockchainExplorerLinks(row.blockchain_tx_hash, {
                manufacturer: onChain.medicine?.manufacturer
                    ? `${ETHERSCAN_BASE}/address/${onChain.medicine.manufacturer}`
                    : null
            }),
            onChain
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===== DISTRIBUTOR ENDPOINTS =====

// 10. DISTRIBUTOR: Incoming deliveries from manufacturers
app.get('/api/distributor/incoming-deliveries', async (req, res) => {
    try {
        const { sessionId } = req.query;

        if (!sessionId) {
            return res.status(401).json({ error: 'Invalid session' });
        }

        const distributorWallet = await getSessionWallet(sessionId);
        if (!distributorWallet) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const userResult = await pool.query(
            'SELECT role FROM users WHERE wallet_address = $1',
            [distributorWallet]
        );

        if (userResult.rows.length === 0 || userResult.rows[0].role !== 'distributor') {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const result = await pool.query(
            `SELECT d.delivery_id, d.medicine_id, d.quantity, d.status, d.created_at,
                    m.name AS medicine_name, m.batch_number, m.expiry_date,
                    u.company_name AS manufacturer_name
             FROM deliveries d
             JOIN medicines m ON d.medicine_id = m.medicine_id
             JOIN users u ON d.source_wallet = u.wallet_address
             WHERE d.target_wallet = $1
               AND d.source_role = 'manufacturer'
               AND d.status = 'PENDING'
               AND d.is_active = TRUE
             ORDER BY d.created_at DESC`,
            [distributorWallet]
        );

        res.json({ success: true, deliveries: result.rows });
    } catch (error) {
        console.error('Get distributor incoming deliveries error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 10b. DISTRIBUTOR: Receive delivery from manufacturer
async function verifyIncomingDeliveryCredentials(medicine, transportVcRaw, expectedSenderDid) {
    const medicineJwt = extractJwtFromVcCredential(medicine?.vc_credential);
    const transportJwt = extractJwtFromVcCredential(transportVcRaw);

    let medicineVc = { verified: false, message: 'VC zdravila ni na voljo' };
    let transportVc = { verified: false, message: 'VC pošiljke ni na voljo' };

    if (medicineJwt) {
        medicineVc = await verifyCredentialJwt(medicineJwt, medicine.manufacturer_did);
    }
    if (transportJwt) {
        transportVc = await verifyCredentialJwt(transportJwt, expectedSenderDid);
    }

    let ipfs = { accessible: false, message: 'IPFS hash ni v bazi' };
    if (medicine.ipfs_hash) {
        ipfs = await verifyIpfsAccessible(medicine.ipfs_hash);
    }

    return { medicineVc, transportVc, ipfs };
}

app.post('/api/distributor/receive-delivery', async (req, res) => {
    try {
        const { sessionId, deliveryId } = req.body;

        if (!sessionId || !deliveryId) {
            return res.status(400).json({ error: 'Manjkajo obvezna polja' });
        }

        const distributorWallet = await getSessionWallet(sessionId);
        if (!distributorWallet) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const pendingDelivery = await pool.query(
            `SELECT d.*, m.*, u.did AS sender_did
             FROM deliveries d
             JOIN medicines m ON d.medicine_id = m.medicine_id
             JOIN users u ON d.source_wallet = u.wallet_address
             WHERE d.delivery_id = $1 AND d.target_wallet = $2
               AND d.source_role = 'manufacturer' AND d.status = 'PENDING'`,
            [deliveryId, distributorWallet]
        );

        if (pendingDelivery.rows.length === 0) {
            return res.status(404).json({ error: 'Dostava ni najdena ali je že sprejeta' });
        }

        const row = pendingDelivery.rows[0];
        const medicineId = row.medicine_id;
        const quantity = row.quantity;
        const medicine = row;

        const verification = await verifyIncomingDeliveryCredentials(
            medicine,
            row.transport_vc_credential,
            row.sender_did
        );

        await pool.query(
            `UPDATE deliveries SET status = 'RECEIVED', received_at = CURRENT_TIMESTAMP
             WHERE delivery_id = $1 AND target_wallet = $2`,
            [deliveryId, distributorWallet]
        );

        const distributorResult = await pool.query(
            'SELECT * FROM users WHERE wallet_address = $1',
            [distributorWallet]
        );
        const distributor = distributorResult.rows[0];

        await pool.query(
            `INSERT INTO supply_chain_history (medicine_id, delivery_id, action, actor_wallet, actor_role, actor_did, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [medicineId, deliveryId, 'RECEIVED_BY_DISTRIBUTOR', distributorWallet, 'distributor',
             distributor.did, JSON.stringify({
                 quantity,
                 receivedAt: new Date().toISOString(),
                 medicineVcVerified: verification.medicineVc.verified,
                 transportVcVerified: verification.transportVc.verified
             })]
        );

        const vcOk = verification.medicineVc.verified && verification.transportVc.verified;

        const transportJwt = extractJwtFromVcCredential(row.transport_vc_credential);
        const chainHandoff = buildChainHandoffPayload({
            medicineId,
            deliveryId,
            quantity,
            counterpartyWallet: row.source_wallet,
            counterpartyDid: row.sender_did,
            eventType: 'RECEIVED_BY_DISTRIBUTOR',
            transportJwt,
            newHolderWallet: distributorWallet,
            newHolderDid: distributor.did
        });

        res.json({
            success: true,
            message: vcOk
                ? (chainHandoff.needsBlockchain ? 'Pošiljka sprejeta — potrdite handoff v MetaMask' : 'Pošiljka sprejeta — VC preverjen')
                : 'Pošiljka sprejeta — preverite opozorila',
            verification,
            chainHandoff
        });
    } catch (error) {
        console.error('Distributor receive delivery error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 10c. DISTRIBUTOR: Get my inventory (stock ready to forward)
app.get('/api/distributor/my-inventory', async (req, res) => {
    try {
        const { sessionId } = req.query;

        if (!sessionId) {
            return res.status(401).json({ error: 'Invalid session' });
        }

        const distributorWallet = await getSessionWallet(sessionId);
        if (!distributorWallet) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const result = await pool.query(
            `SELECT m.medicine_id, m.name, m.batch_number, m.expiry_date, m.blockchain_status,
                    COALESCE(received.total, 0) - COALESCE(sent.total, 0) AS available_quantity,
                    COALESCE(received.total, 0) AS received_quantity,
                    COALESCE(sent.total, 0) AS forwarded_quantity
             FROM medicines m
             JOIN (
                 SELECT medicine_id, SUM(quantity) AS total
                 FROM deliveries
                 WHERE target_wallet = $1 AND source_role = 'manufacturer' AND status = 'RECEIVED'
                 GROUP BY medicine_id
             ) received ON m.medicine_id = received.medicine_id
             LEFT JOIN (
                 SELECT medicine_id, SUM(quantity) AS total
                 FROM deliveries
                 WHERE source_wallet = $1 AND source_role = 'distributor'
                   AND status IN ('IN_TRANSIT', 'DELIVERED')
                 GROUP BY medicine_id
             ) sent ON m.medicine_id = sent.medicine_id
             WHERE COALESCE(received.total, 0) - COALESCE(sent.total, 0) > 0
             ORDER BY m.name`,
            [distributorWallet]
        );

        res.json({ success: true, inventory: result.rows });
    } catch (error) {
        console.error('Get distributor inventory error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 10d. DISTRIBUTOR: Outgoing shipment history
app.get('/api/distributor/outgoing-deliveries', async (req, res) => {
    try {
        const { sessionId } = req.query;

        if (!sessionId) {
            return res.status(401).json({ error: 'Invalid session' });
        }

        const distributorWallet = await getSessionWallet(sessionId);
        if (!distributorWallet) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const result = await pool.query(
            `SELECT d.delivery_id, d.medicine_id, d.quantity, d.status, d.created_at,
                    m.name AS medicine_name, m.batch_number,
                    d.target_pharmacy_name AS pharmacy_name
             FROM deliveries d
             JOIN medicines m ON d.medicine_id = m.medicine_id
             WHERE d.source_wallet = $1 AND d.source_role = 'distributor'
             ORDER BY d.created_at DESC`,
            [distributorWallet]
        );

        res.json({ success: true, deliveries: result.rows });
    } catch (error) {
        console.error('Get distributor outgoing deliveries error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ===== PHARMACY ENDPOINTS =====

// 11. GET INCOMING DELIVERIES - Pharmacy sees medicines being delivered
app.get('/api/pharmacy/incoming-deliveries', async (req, res) => {
    try {
        const { sessionId } = req.query;

        if (!sessionId) {
            return res.status(401).json({ error: 'Invalid session' });
        }

        const userResult = await pool.query(
            'SELECT * FROM users WHERE session_id = $1 AND role = $2',
            [sessionId, 'pharmacy']
        );

        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const pharmacy = userResult.rows[0];

        // Get deliveries targeting this pharmacy
        const deliveriesResult = await pool.query(
            `SELECT d.*, m.name as medicine_name, m.batch_number, m.expiry_date, m.ipfs_hash, m.blockchain_status
             FROM deliveries d
             JOIN medicines m ON d.medicine_id = m.medicine_id
             WHERE d.target_wallet = $1 AND d.status = 'IN_TRANSIT'
               AND d.source_role = 'distributor' AND d.is_active = TRUE
             ORDER BY d.created_at DESC`,
            [pharmacy.wallet_address]
        );

        res.json({
            success: true,
            deliveries: deliveriesResult.rows
        });
    } catch (error) {
        console.error('Get incoming deliveries error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 12. VERIFY MEDICINE ON BLOCKCHAIN - Pharmacy verifies medicine integrity
app.post('/api/pharmacy/verify-medicine', async (req, res) => {
    try {
        const { sessionId, medicineId } = req.body;

        if (!sessionId || !medicineId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const userResult = await pool.query(
            'SELECT * FROM users WHERE session_id = $1 AND role = $2',
            [sessionId, 'pharmacy']
        );

        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        // Get medicine details
        const medicineResult = await pool.query(
            'SELECT * FROM medicines WHERE medicine_id = $1',
            [medicineId]
        );

        if (medicineResult.rows.length === 0) {
            return res.status(404).json({ error: 'Medicine not found' });
        }

        const medicine = medicineResult.rows[0];

        // Get supply chain history
        const historyResult = await pool.query(
            `SELECT * FROM supply_chain_history 
             WHERE medicine_id = $1
             ORDER BY created_at ASC`,
            [medicineId]
        );

        // Verify blockchain (if configured)
        let blockchainData = null;
        try {
            if (ensureBlockchainRead()) {
                blockchainData = await getMedicineFromBlockchain(medicineId);
                const blockchainHistory = await getMedicineHistory(medicineId);
                blockchainData.transactionHistory = blockchainHistory;
            }
        } catch (error) {
            console.log(`Note: Blockchain verification not available: ${error.message}`);
        }

        res.json({
            success: true,
            verification: {
                medicine: {
                    id: medicine.medicine_id,
                    name: medicine.name,
                    batchNumber: medicine.batch_number,
                    quantity: medicine.quantity,
                    expiryDate: medicine.expiry_date,
                    manufacturerName: medicine.manufacturer_name,
                    description: medicine.description
                },
                blockchain: blockchainData,
                supplyChainHistory: historyResult.rows,
                ipfsHash: medicine.ipfs_hash,
                isVerified: medicine.blockchain_status === 'DELIVERED' && medicine.ipfs_hash !== null
            }
        });
    } catch (error) {
        console.error('Verify medicine error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 11. DISTRIBUTOR: Send medicine to pharmacy
app.post('/api/distributor/send-to-pharmacy', async (req, res) => {
    try {
        const { sessionId, medicineId, quantity, targetPharmacyName, targetPharmacyWallet } = req.body;

        if (!sessionId || !medicineId || !quantity || !targetPharmacyName || !targetPharmacyWallet) {
            return res.status(400).json({ error: 'Manjkajo obvezna polja' });
        }

        const distributorWallet = await getSessionWallet(sessionId);
        if (!distributorWallet) {
            return res.status(401).json({ error: 'Unauthorized or invalid session' });
        }

        const distributorResult = await pool.query(
            'SELECT * FROM users WHERE wallet_address = $1 AND role = $2',
            [distributorWallet, 'distributor']
        );

        if (distributorResult.rows.length === 0) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const pharmacyResult = await pool.query(
            'SELECT * FROM users WHERE wallet_address = $1 AND role = $2',
            [targetPharmacyWallet, 'pharmacy']
        );

        if (pharmacyResult.rows.length === 0) {
            return res.status(404).json({ error: 'Lekarna ni registrirana' });
        }

        const available = await getDistributorAvailableQuantity(medicineId, distributorWallet);
        if (quantity > available) {
            return res.status(400).json({ error: `Na voljo je samo ${available} enot v inventarju` });
        }

        const deliveryId = `DELIVERY-${crypto.randomUUID()}`;

        const medicineResult = await pool.query(
            'SELECT * FROM medicines WHERE medicine_id = $1',
            [medicineId]
        );
        const medicine = medicineResult.rows[0];
        const distributor = distributorResult.rows[0];
        const pharmacy = pharmacyResult.rows[0];

        if (!distributor.walt_api_cookie) {
            return res.status(400).json({
                error: 'Distributer nima aktivne Walt.id seje. Ponovno se registrirajte v Walt.id na domači strani.'
            });
        }

        let transportVc = null;
        try {
            if (distributor.did) {
                const issued = await issueHandoffCredential({
                    delivery: { delivery_id: deliveryId, deliveryId, quantity, target_pharmacy_name: targetPharmacyName },
                    medicine,
                    sender: distributor,
                    recipient: pharmacy,
                    eventType: 'FORWARDED_TO_PHARMACY',
                    walletOpts: { walletId: distributor.wallet_id, waltCookie: distributor.walt_api_cookie }
                });
                transportVc = JSON.stringify({ signedJwt: issued.jwt, issuerDid: issued.issuerDid, signed: true, claims: decodeVcClaims(issued.jwt) });
                console.log(`✓ Handoff VC (→ pharmacy) ${deliveryId}`);
            }
        } catch (vcError) {
            console.error(`✗ Handoff VC failed: ${vcError.message}`);
            transportVc = JSON.stringify({ signed: false, error: vcError.message });
        }

        await pool.query(
            `INSERT INTO deliveries
             (delivery_id, medicine_id, source_wallet, source_role, target_wallet, target_role,
              target_pharmacy_name, quantity, status, transport_vc_credential)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [deliveryId, medicineId, distributorWallet, 'distributor', targetPharmacyWallet,
             'pharmacy', targetPharmacyName, quantity, 'IN_TRANSIT', transportVc]
        );

        await pool.query(
            `INSERT INTO supply_chain_history (medicine_id, delivery_id, action, actor_wallet, actor_role, actor_did, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [medicineId, deliveryId, 'FORWARDED_TO_PHARMACY', distributorWallet, 'distributor',
             distributor.did, JSON.stringify({
                 quantity,
                 targetPharmacyName,
                 transportVcIssued: (() => {
                     try {
                         const p = JSON.parse(transportVc || '{}');
                         return Boolean(p.signedJwt || p.signed === true);
                     } catch { return false; }
                 })()
             })]
        );

        const transportJwt = extractJwtFromVcCredential(transportVc);
        const chainHandoff = buildChainHandoffPayload({
            medicineId,
            deliveryId,
            quantity,
            counterpartyWallet: targetPharmacyWallet,
            counterpartyDid: pharmacy.did,
            eventType: 'FORWARDED_TO_PHARMACY',
            transportJwt,
            newHolderWallet: distributorWallet,
            newHolderDid: distributor.did
        });

        res.json({
            success: true,
            message: chainHandoff.needsBlockchain
                ? 'Pošiljka pripravljena — potrdite handoff v MetaMask'
                : 'Zdravilo poslano v lekarno',
            delivery: {
                deliveryId,
                medicineId,
                quantity,
                targetPharmacyName,
                status: 'IN_TRANSIT',
                transportVcIssued: (() => {
                    try {
                        const p = JSON.parse(transportVc || '{}');
                        return Boolean(p.signedJwt || p.signed === true);
                    } catch { return false; }
                })(),
                chainTxHash: null
            },
            chainHandoff
        });
    } catch (error) {
        console.error('Send to pharmacy error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 12. PHARMACY: Receive delivery
app.post('/api/pharmacy/receive-delivery', async (req, res) => {
    try {
        const { sessionId, deliveryId } = req.body;

        if (!sessionId || !deliveryId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Validate session and get pharmacy wallet
        const sessionResult = await pool.query(
            'SELECT wallet_address FROM sessions WHERE session_id = $1',
            [sessionId]
        );

        if (sessionResult.rows.length === 0) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const pharmacyWallet = sessionResult.rows[0].wallet_address;

        await pool.query(
            `UPDATE deliveries SET status = 'DELIVERED', received_at = CURRENT_TIMESTAMP
             WHERE delivery_id = $1 AND target_wallet = $2 AND status = 'IN_TRANSIT'`,
            [deliveryId, pharmacyWallet]
        );

        const deliveredResult = await pool.query(
            `SELECT medicine_id, status, quantity, transport_vc_credential
             FROM deliveries
             WHERE delivery_id = $1 AND target_wallet = $2 AND status = 'DELIVERED'`,
            [deliveryId, pharmacyWallet]
        );

        if (deliveredResult.rows.length === 0) {
            return res.status(404).json({ error: 'Delivery not found or not authorized' });
        }

        const { medicine_id: medicineId, quantity, transport_vc_credential: transportVcRaw } = deliveredResult.rows[0];

        const medicineResult = await pool.query(
            'SELECT * FROM medicines WHERE medicine_id = $1',
            [medicineId]
        );
        const medicine = medicineResult.rows[0];

        const medicineJwt = extractJwtFromVcCredential(medicine?.vc_credential);
        const transportJwt = extractJwtFromVcCredential(transportVcRaw);

        let medicineVcVerification = { verified: false, message: 'VC ni na voljo' };
        let transportVcVerification = { verified: false, message: 'Transport VC ni na voljo' };

        if (medicineJwt) {
            medicineVcVerification = await verifyCredentialJwt(medicineJwt, medicine.manufacturer_did);
        }

        if (transportJwt) {
            const distributorDid = (await pool.query(
                'SELECT did FROM users WHERE wallet_address = (SELECT source_wallet FROM deliveries WHERE delivery_id = $1)',
                [deliveryId]
            )).rows[0]?.did;
            transportVcVerification = await verifyCredentialJwt(transportJwt, distributorDid);
        }

        const pharmacyResult = await pool.query(
            'SELECT * FROM users WHERE wallet_address = $1',
            [pharmacyWallet]
        );
        const pharmacy = pharmacyResult.rows[0];

        // Update medicine blockchain status
        await pool.query(`
            UPDATE medicines SET blockchain_status = 'DELIVERED'
            WHERE medicine_id = $1
        `, [medicineId]);

        await pool.query(`
            INSERT INTO supply_chain_history (medicine_id, delivery_id, action, actor_wallet, actor_role, actor_did, details)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [medicineId, deliveryId, 'RECEIVED_AT_PHARMACY', pharmacyWallet, pharmacy.role, pharmacy.did,
             JSON.stringify({
                 receivedAt: new Date().toISOString(),
                 quantity,
                 medicineVcVerified: medicineVcVerification.verified,
                 transportVcVerified: transportVcVerification.verified
             })]);

        if (medicineVcVerification.verified) {
            await pool.query(
                `INSERT INTO supply_chain_history (medicine_id, delivery_id, action, actor_wallet, actor_role, details)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [medicineId, deliveryId, 'VC_VERIFIED_AT_PHARMACY', pharmacyWallet, 'pharmacy',
                 JSON.stringify({ type: 'MedicineCredential', message: medicineVcVerification.message })]
            );
        }

        let ipfsVerification = { accessible: false, message: 'IPFS hash ni v bazi' };
        if (medicine.ipfs_hash) {
            ipfsVerification = await verifyIpfsAccessible(medicine.ipfs_hash);
            if (ipfsVerification.accessible) {
                await pool.query(
                    `INSERT INTO supply_chain_history (medicine_id, delivery_id, action, actor_wallet, actor_role, details)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [medicineId, deliveryId, 'IPFS_VERIFIED_AT_PHARMACY', pharmacyWallet, 'pharmacy',
                     JSON.stringify({ hash: medicine.ipfs_hash, gateway: ipfsVerification.gateway })]
                );
            }
        }

        const vcOk = medicineVcVerification.verified && transportVcVerification.verified;

        const distributorRow = await pool.query(
            'SELECT source_wallet, u.did AS source_did FROM deliveries d JOIN users u ON d.source_wallet = u.wallet_address WHERE d.delivery_id = $1',
            [deliveryId]
        );
        const distWallet = distributorRow.rows[0]?.source_wallet;
        const distDid = distributorRow.rows[0]?.source_did;

        const chainHandoff = buildChainHandoffPayload({
            medicineId,
            deliveryId,
            quantity,
            counterpartyWallet: distWallet,
            counterpartyDid: distDid,
            eventType: 'RECEIVED_AT_PHARMACY',
            transportJwt,
            newHolderWallet: pharmacyWallet,
            newHolderDid: pharmacy.did
        });

        res.json({
            success: true,
            message: vcOk
                ? (chainHandoff.needsBlockchain ? 'Pošiljka prevzeta — potrdite handoff v MetaMask' : 'Pošiljka prevzeta — VC preverjen')
                : 'Pošiljka prevzeta — preverite opozorila spodaj',
            verification: {
                medicineVc: medicineVcVerification,
                transportVc: transportVcVerification,
                ipfs: ipfsVerification,
                ipfsLinks: getIpfsLinks(medicine.ipfs_hash)
            },
            chainHandoff
        });
    } catch (error) {
        console.error('Receive delivery error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 13. PHARMACY: Get my inventory
app.get('/api/pharmacy/my-inventory', async (req, res) => {
    try {
        const { sessionId } = req.query;

        if (!sessionId) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }

        // Validate session
        if (!(await isSessionValid(sessionId))) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }

        // Get pharmacy wallet from session
        const sessionResult = await pool.query(
            'SELECT wallet_address FROM sessions WHERE session_id = $1',
            [sessionId]
        );

        if (sessionResult.rows.length === 0) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const pharmacyWallet = sessionResult.rows[0].wallet_address;

        // Get medicines received at this pharmacy
        const result = await pool.query(`
            SELECT m.medicine_id, m.id, m.name, m.batch_number, m.expiry_date, m.blockchain_status, m.ipfs_hash,
                   d.delivery_id, d.quantity, d.received_at
            FROM medicines m
            JOIN deliveries d ON m.medicine_id = d.medicine_id
            WHERE d.target_wallet = $1 AND d.status = 'DELIVERED'
            ORDER BY d.received_at DESC
        `, [pharmacyWallet]);
        
        res.json({
            success: true,
            inventory: result.rows.map(row => ({
                medicine_id: row.medicine_id,
                delivery_id: row.delivery_id,
                name: row.name,
                batch_number: row.batch_number,
                quantity: row.quantity,
                expiry_date: formatDateOnly(row.expiry_date),
                received_at: row.received_at,
                blockchain_status: row.blockchain_status,
                ipfs_hash: row.ipfs_hash
            }))
        });
    } catch (error) {
        console.error('Get pharmacy inventory error:', error);
        res.status(500).json({ error: error.message });
    }
});

async function handleMedicineDetailsRequest(req, res) {
    try {
        const medicineId = req.params.medicineId;
        const { sessionId, deliveryId } = req.query;

        if (!sessionId || !(await isSessionValid(sessionId))) {
            return res.status(401).json({ error: 'Neveljavna seja' });
        }

        const userResult = await pool.query(
            'SELECT wallet_address, role FROM users WHERE session_id = $1',
            [sessionId]
        );
        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Uporabnik ni najden' });
        }

        const { wallet_address: viewerWallet, role: viewerRole } = userResult.rows[0];

        if (!(await userCanAccessMedicine(viewerWallet, viewerRole, medicineId))) {
            return res.status(403).json({ error: 'Nimate dostopa do tega zdravila' });
        }

        const medicine = await buildMedicineDetailsResponse(medicineId, {
            viewerWallet,
            viewerRole,
            deliveryId: deliveryId || null
        });

        if (!medicine) {
            return res.status(404).json({ error: 'Zdravilo ni najdeno' });
        }

        res.json({ success: true, medicine, viewerRole });
    } catch (error) {
        console.error('Get medicine details error:', error);
        res.status(500).json({ error: error.message });
    }
}

// 14. Podrobnosti zdravila — vse vloge
app.get('/api/medicines/:medicineId/details', handleMedicineDetailsRequest);
app.get('/api/pharmacy/medicine-details/:medicineId', handleMedicineDetailsRequest);

// 15. LOGIN — MetaMask denarnica + Walt.id email + geslo
app.post('/api/auth/login', async (req, res) => {
    try {
        const { walletAddress, waltEmail, password } = req.body;

        if (!walletAddress || !waltEmail || !password) {
            return res.status(400).json({
                error: 'Manjkajo podatki: denarnica, Walt.id email in geslo'
            });
        }

        if (!isValidEthereumAddress(walletAddress)) {
            return res.status(400).json({ error: 'Neveljaven naslov denarnice' });
        }

        const normalizedAddress = walletAddress.toLowerCase();

        const userResult = await pool.query(
            'SELECT * FROM users WHERE wallet_address = $1',
            [normalizedAddress]
        );

        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Denarnica ni registrirana. Najprej se registrirajte.' });
        }

        const user = userResult.rows[0];
        const walt = await establishWaltIdSession(user, waltEmail, password, { allowRegister: false });

        const sessionId = generateSecureSessionId();

        await pool.query(
            `UPDATE users
             SET session_id = $1, did = $2, wallet_id = $3, walt_api_cookie = $4, walt_email = $5,
                 last_active = CURRENT_TIMESTAMP
             WHERE wallet_address = $6`,
            [sessionId, walt.did, walt.walletId, walt.sessionCookie, walt.waltEmail, normalizedAddress]
        );

        await pool.query(
            `INSERT INTO sessions (session_id, wallet_address, expires_at)
             VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '7 days')`,
            [sessionId, normalizedAddress]
        );

        const updatedUser = (await pool.query(
            'SELECT * FROM users WHERE wallet_address = $1',
            [normalizedAddress]
        )).rows[0];

        console.log(`✓ Prijava: ${normalizedAddress} | Walt.id: ${walt.waltEmail}`);

        res.json({
            success: true,
            message: 'Prijava uspešna',
            sessionId,
            user: formatAuthUserResponse(updatedUser, walt),
            needsOnChainRegistration: Boolean(CONTRACT_ADDRESS && updatedUser.did),
            onChainRegistration: {
                did: updatedUser.did,
                role: updatedUser.role
            }
        });
    } catch (error) {
        console.error('Login error:', error.message);
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

// 16. DISTRIBUTORS LIST - Get all distributor users
app.get('/api/distributors/list', async (req, res) => {
    try {
        const { sessionId } = req.query;

        if (!sessionId) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }

        if (!(await isSessionValid(sessionId))) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }

        const distributors = await pool.query(
            'SELECT wallet_address, company_name FROM users WHERE role = $1 ORDER BY company_name',
            ['distributor']
        );

        res.json({
            success: true,
            distributors: distributors.rows.map(d => ({
                walletAddress: d.wallet_address,
                name: d.company_name
            }))
        });
    } catch (error) {
        console.error('Get distributors error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 17. PHARMACIES LIST - Get all pharmacy users
app.get('/api/pharmacies/list', async (req, res) => {
    try {
        const { sessionId } = req.query;

        if (!sessionId) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }

        // Validate session
        if (!(await isSessionValid(sessionId))) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }

        // Get all pharmacy users
        const pharmacies = await pool.query(
            'SELECT wallet_address, company_name FROM users WHERE role = $1 ORDER BY company_name',
            ['pharmacy']
        );

        res.json({
            success: true,
            pharmacies: pharmacies.rows.map(p => ({
                walletAddress: p.wallet_address,
                name: p.company_name
            }))
        });
    } catch (error) {
        console.error('Get pharmacies error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 18. PHARMACY: Verify medicine on blockchain (GET alias for dashboard)
app.get('/api/pharmacy/verify-blockchain', async (req, res) => {
    try {
        const { sessionId, medicineId } = req.query;

        if (!sessionId) {
            return res.status(401).json({ error: 'Invalid session' });
        }

        if (!(await isSessionValid(sessionId))) {
            return res.status(401).json({ error: 'Invalid session' });
        }

        if (!medicineId) {
            return res.status(400).json({ error: 'Manjka medicineId' });
        }

        const medicineResult = await pool.query(
            'SELECT * FROM medicines WHERE medicine_id = $1',
            [medicineId]
        );
        const medicine = medicineResult.rows[0];
        if (!medicine) {
            return res.status(404).json({ error: 'Zdravilo ni najdeno' });
        }

        const medicineJwt = extractJwtFromVcCredential(medicine.vc_credential);

        let vcVerification = { verified: false, message: 'VC ni na voljo' };
        if (medicineJwt) {
            vcVerification = await verifyCredentialJwt(medicineJwt, medicine.manufacturer_did);
        }

        const blockchainConfigured = Boolean(SEPOLIA_RPC_URL && CONTRACT_ADDRESS);

        let blockchainData = null;
        let onChainVerified = false;
        let chainStatus = null;

        if (blockchainConfigured) {
            try {
                if (ensureBlockchainRead()) {
                    blockchainData = await getMedicineFromBlockchain(medicineId);
                    onChainVerified = Boolean(blockchainData?.medicineId || blockchainData?.ipfsHash);
                    chainStatus = blockchainData?.status || null;
                }
            } catch (error) {
                console.log(`Blockchain verify note: ${error.message}`);
            }
        }

        const ipfsVerified = Boolean(medicine.ipfs_hash);
        const hasTxHash = Boolean(medicine.blockchain_tx_hash);
        const systemVerified = (vcVerification.verified || ipfsVerified) && medicine.blockchain_status === 'DELIVERED';

        let message;
        if (onChainVerified) {
            message = `Zdravilo je na blockchainu (status: ${chainStatus}).`;
        } else if (vcVerification.verified) {
            message = `Walt.id VC preverjen. ${vcVerification.structuralOnly ? '(strukturno)' : '(podpis)'}`;
        } else if (systemVerified && ipfsVerified) {
            message = hasTxHash
                ? 'Potrjeno v sistemu (IPFS + TX hash).'
                : 'Potrjeno v sistemu. TX hash manjka — potrdite registerMedicine v MetaMask.';
        } else if (ipfsVerified) {
            message = 'IPFS zapis obstaja. VC/blockchain preverjanje ni uspelo.';
        } else if (!blockchainConfigured) {
            message = 'Blockchain ni konfiguriran (SEPOLIA_RPC_URL, CONTRACT_ADDRESS).';
        } else {
            message = 'Polno preverjanje ni uspelo.';
        }

        const blockchainExplorer = getBlockchainExplorerLinks(medicine.blockchain_tx_hash, {
            manufacturer: blockchainData?.manufacturer
                ? `${ETHERSCAN_BASE}/address/${blockchainData.manufacturer}`
                : null
        });

        res.json({
            success: true,
            verified: onChainVerified || vcVerification.verified || systemVerified,
            onChainVerified,
            systemVerified,
            vcVerification,
            ipfsVerified,
            blockchainConfigured,
            hasTxHash,
            ipfsLinks: getIpfsLinks(medicine.ipfs_hash),
            blockchainExplorer,
            onChain: blockchainData ? { medicine: blockchainData } : null,
            dbStatus: medicine.blockchain_status,
            chainStatus,
            status: chainStatus || medicine.blockchain_status,
            txHash: medicine.blockchain_tx_hash || null,
            ipfsHash: medicine.ipfs_hash || null,
            message,
            blockchain: blockchainData
        });
    } catch (error) {
        console.error('Verify blockchain error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 19. HEALTH CHECK
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        services: {
            walt_id: WALT_API,
            ethereum: SEPOLIA_RPC_URL ? 'configured' : 'not configured',
            database: 'connected'
        }
    });
});

// ===== ERROR HANDLING =====
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ===== START SERVER =====
async function startServer() {
    try {
        // Test database connection
        await pool.query('SELECT NOW()');
        console.log('✓ Database connection successful');

        const cfg = getIntegrationConfigStatus();
        if (SEPOLIA_RPC_URL && CONTRACT_ADDRESS) {
            ensureBlockchainRead();
        }
        app.listen(PORT, () => {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`✓ Server running on http://localhost:${PORT}`);
            console.log(`✓ Walt.id Wallet: ${WALT_API || 'NOT configured'}`);
            console.log(`✓ Walt.id Issuer:  ${WALT_ISSUER_API}`);
            console.log(`✓ Walt.id Verifier: ${WALT_VERIFIER_API}`);
            console.log(`✓ Pinata/IPFS: ${cfg.pinata.configured ? 'configured' : 'NOT configured (src/.env)'}`);
            console.log(`✓ Ethereum RPC: ${cfg.blockchain.rpcSet ? 'configured' : 'NOT configured'}`);
            console.log(`✓ Contract: ${CONTRACT_ADDRESS || 'NOT configured'}`);
            console.log(`✓ Blockchain podpis: MetaMask (Sepolia)`);
            console.log(`✓ Status API: http://localhost:${PORT}/api/system/status`);
            console.log(`✓ Database: app-postgres on port ${process.env.APP_POSTGRES_DB_PORT || 5433}`);
            console.log(`✓ Session expiry: ${SESSION_EXPIRY_HOURS} hours`);
            console.log('\n' + '='.repeat(60) + '\n');
        });
    } catch (error) {
        console.error('Failed to start server:', error.message);
        process.exit(1);
    }
}

startServer();
