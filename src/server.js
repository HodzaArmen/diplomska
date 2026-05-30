/**
 * server.js
 * Main Express server with MetaMask authentication and role-based dashboards
 * Supports multiple users/accounts with different roles: Manufacturer, Distributor, Pharmacy
 * Uses PostgreSQL for persistent data storage
 */

import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { ethers } from 'ethers';
import { Pool } from 'pg';
import rateLimit from 'express-rate-limit';
import { uploadProductData } from './ipfs.js';
import { initializeBlockchain, registerMedicineOnBlockchain, getMedicineFromBlockchain, getMedicineHistory } from './blockchain.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

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
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const PORT = process.env.PORT || 3000;
const SESSION_EXPIRY_HOURS = 168; // 7 days - NOTE: Keep in sync with SQL INTERVAL '7 days'
const API_TIMEOUT_MS = 30000;

// ===== DATABASE CONFIGURATION =====
const pool = new Pool({
    user: process.env.APP_DB_USERNAME,
    password: process.env.APP_DB_PASSWORD,
    host: process.env.APP_DB_HOST,
    port: process.env.APP_POSTGRES_DB_PORT || 5433,
    database: process.env.APP_DB_NAME 
});

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

// ===== HELPER: Walt.id API calls =====
async function callWaltAPI(method, endpoint, data = null, sessionCookie = null) {
    try {
        const config = {
            method,
            url: `${WALT_API}${endpoint}`,
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: API_TIMEOUT_MS
        };

        if (sessionCookie) {
            config.headers.Cookie = sessionCookie;
        }

        if (data) {
            config.data = data;
        }

        const response = await axios(config);
        
        // Extract and return session cookie if present
        const setCookie = response.headers?.['set-cookie'];
        const newCookie = setCookie ? setCookie.map(c => c.split(';')[0]).join('; ') : sessionCookie;

        return { data: response.data, cookie: newCookie };
    } catch (error) {
        console.error(`[Walt.id ERROR] ${method} ${endpoint}: ${error.message}`);
        throw error;
    }
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
            return res.status(200).json({
                success: true,
                message: 'Wallet already registered',
                alreadyRegistered: true,
                sessionId: user.session_id,
                user: {
                    walletAddress: user.wallet_address,
                    role: user.role,
                    companyName: user.company_name,
                    email: user.email,
                    did: user.did,
                    walletId: user.wallet_id
                }
            });
        }

        // Create new user session with cryptographically secure random ID
        const sessionId = generateSecureSessionId();
        
        // Insert user into database
        const newUser = await pool.query(
            `INSERT INTO users 
             (wallet_address, role, email, company_name, session_id) 
             VALUES ($1, $2, $3, $4, $5) 
             RETURNING *`,
            [normalizedAddress, role.toLowerCase(), sanitizedEmail, sanitizedCompanyName, sessionId]
        );

        const userRecord = newUser.rows[0];
        
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
            'SELECT wallet_address, role, company_name, email, did, wallet_id FROM users WHERE wallet_address = $1',
            [normalizedAddress]
        );

        if (userResult.rows.length === 0) {
            return res.json({ registered: false });
        }

        const user = userResult.rows[0];
        res.json({
            registered: true,
            hasWaltId: !!(user.did && user.wallet_id),
            user: {
                walletAddress: user.wallet_address,
                role: user.role,
                companyName: user.company_name,
                email: user.email,
                did: user.did,
                walletId: user.wallet_id
            }
        });
    } catch (error) {
        console.error('Check wallet error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 2. WALT.ID REGISTRATION - Register user in Walt.id and get DID
app.post('/api/auth/register-walt', async (req, res) => {
    try {
        const { sessionId, password } = req.body;
        console.log(`[Walt.id Registration] Session ID: ${sessionId}`);
        console.log(`[Walt.id Registration] Password provided: ${!!password}`);

        if (!sessionId) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }

        // Validate session
        if (!(await isSessionValid(sessionId))) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }

        // Get user from database
        const userResult = await pool.query(
            'SELECT * FROM users WHERE session_id = $1',
            [sessionId]
        );

        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid or expired session 3' });
        }

        const userRecord = userResult.rows[0];

        // Check if already registered in Walt.id
        if (userRecord.did && userRecord.wallet_id) {
            return res.status(200).json({
                success: true,
                message: 'Already registered in Walt.id',
                user: {
                    walletAddress: userRecord.wallet_address,
                    role: userRecord.role,
                    companyName: userRecord.company_name,
                    email: userRecord.email,
                    did: userRecord.did,
                    walletId: userRecord.wallet_id
                }
            });
        }

        // Generate unique Walt.id account for this user
        const waltEmail = `${userRecord.wallet_address.toLowerCase()}_${userRecord.role}@diplomska.local`;

        console.log(`[Walt.id] Registering: ${waltEmail}`);

        let registerResult;
        let isNewUser = false;
        try {
            // Try to register with user-provided password
            registerResult = await callWaltAPI('POST', '/auth/register', {
                type: 'email',
                name: userRecord.company_name,
                email: waltEmail,
                password: password
            });
            isNewUser = true;
        } catch (registerError) {
            // If already registered, that's fine - we'll just login
            if (registerError?.response?.status === 409) {
                console.log('[Walt.id] User already exists, will login...');
            } else {
                throw registerError;
            }
        }

        // After registration (new or existing user), must login to get session cookie
        // because /auth/register doesn't return a session cookie
        const loginResult = await callWaltAPI('POST', '/auth/login', {
            type: 'email',
            email: waltEmail,
            password: password
        });

        let sessionCookie = loginResult.cookie;

        if (isNewUser) {
            console.log(`✓ Walt.id user created: ${waltEmail}`);
        }
        console.log(`✓ Walt.id session established`);


        // Get wallet ID
        let walletId;
        try {
            const walletsResult = await callWaltAPI('GET', '/wallet/accounts/wallets', null, sessionCookie);
            sessionCookie = walletsResult.cookie;
            if (walletsResult.data?.wallets?.length > 0) {
                walletId = walletsResult.data.wallets[0].id;
            } else {
                throw new Error('No wallets found');
            }
        } catch (error) {
            console.error('Failed to get wallet ID:', error.message);
            throw error;
        }

        // Get DID for this wallet
        let did;
        try {
            const didsResult = await callWaltAPI('GET', `/wallet/${walletId}/dids`, null, sessionCookie);
            sessionCookie = didsResult.cookie;
            did = extractDidValue(didsResult.data);
            if (!did) {
                throw new Error('No DID found');
            }
        } catch (error) {
            console.error('Failed to get DID:', error.message);
            throw error;
        }

        // Update user record in database
        const updatedUser = await pool.query(
            `UPDATE users 
             SET did = $1, wallet_id = $2, walt_id_registered_at = CURRENT_TIMESTAMP, last_active = CURRENT_TIMESTAMP
             WHERE session_id = $3 
             RETURNING *`,
            [did, walletId, sessionId]
        );

        const updatedUserRecord = updatedUser.rows[0];
        
        // Update session activity
        await pool.query(
            'UPDATE sessions SET last_activity = CURRENT_TIMESTAMP WHERE session_id = $1',
            [sessionId]
        );

        console.log(`✓ User registered in Walt.id: ${waltEmail}`);
        console.log(`✓ DID: ${did}`);
        console.log(`✓ Wallet ID: ${walletId}`);

        res.json({
            success: true,
            message: 'User registered in Walt.id successfully',
            user: {
                walletAddress: updatedUserRecord.wallet_address,
                role: updatedUserRecord.role,
                companyName: updatedUserRecord.company_name,
                email: updatedUserRecord.email,
                did,
                walletId
            }
        });
    } catch (error) {
        console.error('Walt.id registration error:', error.message);
        res.status(500).json({ error: error.message });
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

// ===== MEDICINE MANAGEMENT ENDPOINTS =====

// 6. GET MEDICINE TEMPLATES - Get predefined medicine list
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

        const medicineId = `MED-${crypto.randomUUID()}`;

        // Start transaction
        await client.query('BEGIN');

        // 1. Insert medicine record
        const medicineInsert = await client.query(
            `INSERT INTO medicines 
             (medicine_id, name, description, quantity, batch_number, expiry_date, 
              manufacturer_wallet, manufacturer_did, manufacturer_name, blockchain_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`,
            [medicineId, medicineName, description || '', quantity, batchNumber, expiryDate,
             user.wallet_address, user.did, user.company_name, 'MANUFACTURED']
        );

        const medicine = medicineInsert.rows[0];

        // 2. Create VC credential (backend automation)
        const vcData = {
            "@context": ["https://www.w3.org/2018/credentials/v1"],
            "type": ["VerifiableCredential", "MedicineCredential"],
            "issuer": user.did,
            "issuanceDate": new Date().toISOString(),
            "credentialSubject": {
                "medicineId": medicineId,
                "name": medicineName,
                "batchNumber": batchNumber,
                "quantity": quantity,
                "expiryDate": expiryDate,
                "manufacturer": user.company_name,
                "manufacturerDID": user.did,
                "description": description
            }
        };

        // 3. Upload to IPFS (using the ipfs.js helper)
        let ipfsHash = null;
        try {
            ipfsHash = await uploadProductData({
                medicineId,
                name: medicineName,
                batchNumber,
                quantity,
                expiryDate,
                manufacturer: user.company_name,
                manufacturerDID: user.did,
                description: description || '',
                serialNumber: medicineId,
                uploadedAt: new Date().toISOString()
            });
            console.log(`✓ Medicine uploaded to IPFS: ${ipfsHash}`);
        } catch (error) {
            console.error(`✗ IPFS upload failed: ${error.message}`);
            // Continue anyway - blockchain registration might still work
        }

        // 4. Register on blockchain (backend automation)
        let blockchainTxHash = null;
        let blockchainStatus = null;
        try {
            if (!global.blockchain) {
                const privateKey = process.env.BLOCKCHAIN_PRIVATE_KEY;
                if (privateKey) {
                    global.blockchain = initializeBlockchain(SEPOLIA_RPC_URL, privateKey, CONTRACT_ADDRESS);
                }
            }

            if (global.blockchain && ipfsHash) {
                const receipt = await registerMedicineOnBlockchain(medicineId, ipfsHash);
                blockchainTxHash = receipt?.hash || receipt?.transactionHash;
                blockchainStatus = 'MANUFACTURED';
                console.log(`✓ Medicine registered on blockchain: ${blockchainTxHash}`);
            }
        } catch (error) {
            console.error(`✗ Blockchain registration failed: ${error.message}`);
            // Continue - medicine is still recorded in database
        }

        // 5. Update medicine with IPFS hash and blockchain info
        await client.query(
            `UPDATE medicines 
             SET ipfs_hash = $1, blockchain_tx_hash = $2, blockchain_status = $3, vc_credential = $4
             WHERE medicine_id = $5`,
            [ipfsHash, blockchainTxHash, blockchainStatus || 'MANUFACTURED', JSON.stringify(vcData), medicineId]
        );

        // 6. Log to supply chain history
        await client.query(
            `INSERT INTO supply_chain_history (medicine_id, action, actor_wallet, actor_role, actor_did, details, blockchain_tx_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [medicineId, 'CREATED', user.wallet_address, 'manufacturer', user.did, 
             JSON.stringify({ medicineName, batchNumber, quantity, targetPharmacyName }), blockchainTxHash]
        );

        // Commit transaction
        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Medicine created successfully',
            medicine: {
                medicineId,
                name: medicineName,
                batchNumber,
                quantity,
                expiryDate,
                ipfsHash,
                blockchainTxHash,
                blockchainStatus: blockchainStatus || 'MANUFACTURED',
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
        const distributorName = targetDistributorName || distributorResult.rows[0].company_name;

        await pool.query(
            `INSERT INTO deliveries
             (delivery_id, medicine_id, source_wallet, source_role, target_wallet, target_role,
              target_pharmacy_name, quantity, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [deliveryId, medicineId, manufacturer.wallet_address, 'manufacturer',
             targetDistributorWallet, 'distributor', distributorName, quantity, 'PENDING']
        );

        await pool.query(
            `UPDATE medicines SET blockchain_status = 'IN_TRANSIT' WHERE medicine_id = $1`,
            [medicineId]
        );

        await pool.query(
            `INSERT INTO supply_chain_history (medicine_id, delivery_id, action, actor_wallet, actor_role, actor_did, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [medicineId, deliveryId, 'SENT_TO_DISTRIBUTOR', manufacturer.wallet_address, 'manufacturer',
             manufacturer.did, JSON.stringify({ quantity, targetDistributorName: distributorName })]
        );

        res.json({
            success: true,
            message: 'Zdravilo poslano distributorju',
            delivery: {
                deliveryId,
                medicineId,
                quantity,
                targetDistributorName: distributorName,
                status: 'PENDING'
            }
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
                    m.quantity - COALESCE(SUM(d.quantity), 0) AS available_quantity
             FROM medicines m
             LEFT JOIN deliveries d ON m.medicine_id = d.medicine_id
                AND d.source_wallet = m.manufacturer_wallet
                AND d.source_role = 'manufacturer'
             WHERE m.manufacturer_wallet = $1 AND m.is_active = TRUE
             GROUP BY m.id
             ORDER BY m.created_at DESC`,
            [manufacturer.wallet_address]
        );

        res.json({
            success: true,
            medicines: medicinesResult.rows
        });
    } catch (error) {
        console.error('Get medicines error:', error.message);
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

        const result = await pool.query(
            `UPDATE deliveries
             SET status = 'RECEIVED', received_at = CURRENT_TIMESTAMP
             WHERE delivery_id = $1 AND target_wallet = $2
               AND source_role = 'manufacturer' AND status = 'PENDING'
             RETURNING medicine_id, quantity`,
            [deliveryId, distributorWallet]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Dostava ni najdena ali je že sprejeta' });
        }

        const { medicine_id: medicineId, quantity } = result.rows[0];

        const distributorResult = await pool.query(
            'SELECT * FROM users WHERE wallet_address = $1',
            [distributorWallet]
        );
        const distributor = distributorResult.rows[0];

        await pool.query(
            `INSERT INTO supply_chain_history (medicine_id, delivery_id, action, actor_wallet, actor_role, actor_did, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [medicineId, deliveryId, 'RECEIVED_BY_DISTRIBUTOR', distributorWallet, 'distributor',
             distributor.did, JSON.stringify({ quantity, receivedAt: new Date().toISOString() })]
        );

        res.json({ success: true, message: 'Dostava uspešno sprejeta v inventar' });
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
            if (!global.blockchain && process.env.BLOCKCHAIN_PRIVATE_KEY) {
                global.blockchain = initializeBlockchain(SEPOLIA_RPC_URL, process.env.BLOCKCHAIN_PRIVATE_KEY, CONTRACT_ADDRESS);
            }

            if (global.blockchain) {
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

        await pool.query(
            `INSERT INTO deliveries
             (delivery_id, medicine_id, source_wallet, source_role, target_wallet, target_role,
              target_pharmacy_name, quantity, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [deliveryId, medicineId, distributorWallet, 'distributor', targetPharmacyWallet,
             'pharmacy', targetPharmacyName, quantity, 'IN_TRANSIT']
        );

        const distributor = distributorResult.rows[0];

        await pool.query(
            `INSERT INTO supply_chain_history (medicine_id, delivery_id, action, actor_wallet, actor_role, actor_did, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [medicineId, deliveryId, 'FORWARDED_TO_PHARMACY', distributorWallet, 'distributor',
             distributor.did, JSON.stringify({ quantity, targetPharmacyName })]
        );

        res.json({
            success: true,
            message: 'Zdravilo poslano v lekarno',
            delivery: {
                deliveryId,
                medicineId,
                quantity,
                targetPharmacyName,
                status: 'IN_TRANSIT'
            }
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

        // Update delivery status - only if targeting this pharmacy
        const result = await pool.query(`
            UPDATE deliveries SET status = 'DELIVERED', received_at = CURRENT_TIMESTAMP
            WHERE delivery_id = $1 AND target_wallet = $2 AND status = 'IN_TRANSIT'
            RETURNING medicine_id, status, quantity
        `, [deliveryId, pharmacyWallet]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Delivery not found or not authorized' });
        }

        const medicineId = result.rows[0].medicine_id;

        // Get pharmacy info for history logging
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

        // Log action to supply chain history
        await pool.query(`
            INSERT INTO supply_chain_history (medicine_id, delivery_id, action, actor_wallet, actor_role, actor_did, details)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [medicineId, deliveryId, 'RECEIVED_AT_PHARMACY', pharmacyWallet, pharmacy.role, pharmacy.did, JSON.stringify({ receivedAt: new Date().toISOString() })]);

        res.json({
            success: true,
            message: 'Delivery received successfully'
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
                   d.quantity, d.created_at as received_at
            FROM medicines m
            JOIN deliveries d ON m.medicine_id = d.medicine_id
            WHERE d.target_wallet = $1 AND d.status = 'DELIVERED'
            ORDER BY d.created_at DESC
        `, [pharmacyWallet]);
        
        res.json({
            success: true,
            inventory: result.rows.map(row => ({
                medicine_id: row.medicine_id,
                name: row.name,
                batch_number: row.batch_number,
                quantity: row.quantity,
                expiry_date: row.expiry_date,
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

// 14. PHARMACY: Get medicine details with full supply chain info
app.get('/api/pharmacy/medicine-details/:medicineId', async (req, res) => {
    try {
        const { medicineId } = req.params;
        const { sessionId } = req.query;

        if (!sessionId) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }

        // Validate session
        if (!(await isSessionValid(sessionId))) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }
        
        // Get medicine
        const medicineResult = await pool.query(
            `SELECT m.*, u.company_name as manufacturer_name 
             FROM medicines m 
             JOIN users u ON m.manufacturer_wallet = u.wallet_address 
             WHERE m.medicine_id = $1`,
            [medicineId]
        );
        
        if (medicineResult.rows.length === 0) {
            return res.status(404).json({ error: 'Medicine not found' });
        }
        
        const medicine = medicineResult.rows[0];
        
        // Get supply chain history with specific columns only
        const historyResult = await pool.query(
            `SELECT action, actor_wallet, actor_role, actor_did, created_at, details
             FROM supply_chain_history 
             WHERE medicine_id = $1 
             ORDER BY created_at ASC`,
            [medicineId]
        );
        
        res.json({
            success: true,
            medicine: {
                medicineId: medicine.medicine_id,
                id: medicine.id,
                name: medicine.name,
                batchNumber: medicine.batch_number,
                quantity: medicine.quantity,
                expiryDate: medicine.expiry_date,
                manufacturerName: medicine.manufacturer_name,
                description: medicine.description,
                blockchainStatus: medicine.blockchain_status,
                txHash: medicine.blockchain_tx_hash,
                blockchainVerified: medicine.blockchain_status === 'DELIVERED',
                ipfsHash: medicine.ipfs_hash,
                supplyChainHistory: historyResult.rows.map(row => ({
                    action: row.action,
                    actor: row.actor_wallet,
                    actorRole: row.actor_role,
                    timestamp: row.created_at,
                    details: row.details ? JSON.parse(row.details) : null
                }))
            }
        });
    } catch (error) {
        console.error('Get medicine details error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 15. LOGIN ENDPOINT - Allow existing users to login with wallet
app.post('/api/auth/login', async (req, res) => {
    try {
        const { walletAddress } = req.body;

        if (!walletAddress) {
            return res.status(400).json({ error: 'Missing wallet address' });
        }

        if (!isValidEthereumAddress(walletAddress)) {
            return res.status(400).json({ error: 'Invalid wallet address format' });
        }

        const normalizedAddress = walletAddress.toLowerCase();

        // Check if user exists
        const userResult = await pool.query(
            'SELECT * FROM users WHERE wallet_address = $1',
            [normalizedAddress]
        );

        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Wallet not found. Please register first.' });
        }

        const user = userResult.rows[0];

        // Create new session
        const sessionId = generateSecureSessionId();
        
        // Update user session
        await pool.query(
            'UPDATE users SET session_id = $1 WHERE wallet_address = $2',
            [sessionId, normalizedAddress]
        );

        // Create session record
        await pool.query(
            `INSERT INTO sessions (session_id, wallet_address, expires_at)
             VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '7 days')`,
            [sessionId, normalizedAddress]
        );

        res.json({
            success: true,
            message: 'Login successful',
            sessionId,
            user: {
                walletAddress: user.wallet_address,
                role: user.role,
                companyName: user.company_name,
                email: user.email,
                did: user.did,
                walletId: user.wallet_id
            }
        });
    } catch (error) {
        console.error('Login error:', error.message);
        res.status(500).json({ error: error.message });
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
        const { sessionId, medicineId, txHash } = req.query;

        if (!sessionId) {
            return res.status(401).json({ error: 'Invalid session' });
        }

        if (!(await isSessionValid(sessionId))) {
            return res.status(401).json({ error: 'Invalid session' });
        }

        let medicine = null;
        if (medicineId) {
            const medicineResult = await pool.query(
                'SELECT * FROM medicines WHERE medicine_id = $1',
                [medicineId]
            );
            medicine = medicineResult.rows[0] || null;
        }

        let blockchainData = null;
        const lookupId = medicine?.medicine_id || medicineId;
        if (lookupId) {
            try {
                if (!global.blockchain && process.env.BLOCKCHAIN_PRIVATE_KEY) {
                    global.blockchain = initializeBlockchain(SEPOLIA_RPC_URL, process.env.BLOCKCHAIN_PRIVATE_KEY, CONTRACT_ADDRESS);
                }
                if (global.blockchain) {
                    blockchainData = await getMedicineFromBlockchain(lookupId);
                }
            } catch (error) {
                console.log(`Blockchain verify note: ${error.message}`);
            }
        }

        const verified = Boolean(
            blockchainData || medicine?.blockchain_tx_hash || txHash
        );

        res.json({
            success: true,
            verified,
            status: blockchainData?.status || medicine?.blockchain_status || 'UNKNOWN',
            txHash: txHash || medicine?.blockchain_tx_hash || null,
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
        
        app.listen(PORT, () => {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`✓ Server running on http://localhost:${PORT}`);
            console.log(`✓ Walt.id API: ${WALT_API}`);
            console.log(`✓ Ethereum RPC: ${SEPOLIA_RPC_URL ? 'configured' : 'NOT configured'}`);
            console.log(`✓ Contract: ${CONTRACT_ADDRESS || 'NOT configured'}`);
            console.log(`✓ Database: app-postgres on port ${process.env.APP_POSTGRES_DB_PORT || 5433}`);
            console.log(`✓ PgAdmin: http://localhost:${process.env.PG_ADMIN_PORT || 5050}`);
            console.log(`✓ Session expiry: ${SESSION_EXPIRY_HOURS} hours`);
            console.log('\n' + '='.repeat(60) + '\n');
        });
    } catch (error) {
        console.error('Failed to start server:', error.message);
        process.exit(1);
    }
}

startServer();
