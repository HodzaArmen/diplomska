/**
 * server.js
 * Main Express server with MetaMask authentication and role-based dashboards
 * Supports multiple users/accounts with different roles: Manufacturer, Distributor, Pharmacy
 * Uses PostgreSQL for persistent data storage
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { ethers } = require('ethers');
const { Pool } = require('pg');

const app = express();

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

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
                message: 'Wallet already connected',
                sessionId: user.session_id,
                user: {
                    walletAddress: user.wallet_address,
                    role: user.role,
                    companyName: user.company_name,
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
                companyName: userRecord.company_name
            }
        });
    } catch (error) {
        console.error('MetaMask connection error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 2. WALT.ID REGISTRATION - Register user in Walt.id and get DID
app.post('/api/auth/register-walt', async (req, res) => {
    try {
        const { sessionId, password } = req.body;

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
            return res.status(401).json({ error: 'Invalid or expired session' });
        }

        const userRecord = userResult.rows[0];

        // Check if already registered in Walt.id
        if (userRecord.did && userRecord.wallet_id) {
            return res.status(200).json({
                success: true,
                message: 'Already registered in Walt.id',
                user: {
                    walletAddress: userRecord.wallet_address,
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

// 6. HEALTH CHECK
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

module.exports = app;
