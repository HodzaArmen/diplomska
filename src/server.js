/**
 * server-new.js
 * Main Express server with MetaMask authentication and role-based dashboards
 * Supports multiple users/accounts with different roles: Manufacturer, Distributor, Pharmacy
 * Uses PostgreSQL for persistent data storage
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const { Pool } = require('pg');

const app = express();

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== CONFIGURATION =====
const WALT_API = process.env.WALT_ID_API_URL || 'http://localhost:7001/wallet-api';
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const PORT = process.env.PORT || 3000;

// ===== DATABASE CONFIGURATION =====
const pool = new Pool({
    user: process.env.APP_DB_USERNAME || 'app_user',
    password: process.env.APP_DB_PASSWORD || 'app_password_secure',
    host: process.env.APP_DB_HOST || 'localhost',
    port: process.env.APP_POSTGRES_DB_PORT || 5433,
    database: process.env.APP_DB_NAME || 'diplomska_app'
});

// ===== DATABASE INITIALIZATION =====
async function initializeDatabase() {
    try {
        // Create users table if not exists
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                wallet_address VARCHAR(255) UNIQUE NOT NULL,
                role VARCHAR(50) NOT NULL,
                email VARCHAR(255) NOT NULL,
                company_name VARCHAR(255) NOT NULL,
                wallet_connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                walt_id_registered_at TIMESTAMP,
                did VARCHAR(255),
                wallet_id VARCHAR(255),
                session_id VARCHAR(255) UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create sessions table if not exists
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                id SERIAL PRIMARY KEY,
                session_id VARCHAR(255) UNIQUE NOT NULL,
                wallet_address VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '7 days'),
                FOREIGN KEY (wallet_address) REFERENCES users(wallet_address) ON DELETE CASCADE
            )
        `);

        console.log('✓ Database tables initialized successfully');
    } catch (error) {
        console.error('Database initialization error:', error.message);
        throw error;
    }
}

// ===== IN-MEMORY SESSION CACHE (for quick lookups) =====
const sessionCache = new Map(); // sessionId -> userRecord

// ===== PASSWORD VALIDATION =====
function validatePassword(password) {
    if (!password) {
        return { valid: false, error: 'Geslo je obvezno' };
    }
    if (password.length < 8) {
        return { valid: false, error: 'Geslo mora imeti najmanj 8 znakov' };
    }
    if (!/[A-Z]/.test(password)) {
        return { valid: false, error: 'Geslo mora vsebovati vsaj eno veliko črko' };
    }
    if (!/[a-z]/.test(password)) {
        return { valid: false, error: 'Geslo mora vsebovati vsaj eno malo črko' };
    }
    if (!/[0-9]/.test(password)) {
        return { valid: false, error: 'Geslo mora vsebovati vsaj eno števko' };
    }
    if (!/[!@#$%^&*]/.test(password)) {
        return { valid: false, error: 'Geslo mora vsebovati vsaj en posebni znak (!@#$%^&*)' };
    }
    return { valid: true };
}

// ===== HELPER: Walt.id API calls =====
async function callWaltAPI(method, endpoint, data = null, sessionCookie = null) {
    try {
        const config = {
            method,
            url: `${WALT_API}${endpoint}`,
            headers: {
                'Content-Type': 'application/json'
            }
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

// ===== ENDPOINTS =====

// 1. METAMASK CONNECTION - User connects their MetaMask wallet
app.post('/api/auth/connect-metamask', async (req, res) => {
    try {
        const { walletAddress, role, companyName, email } = req.body;

        if (!walletAddress || !role || !companyName || !email) {
            return res.status(400).json({ error: 'Missing required fields: walletAddress, role, companyName, email' });
        }

        if (!['manufacturer', 'distributor', 'pharmacy'].includes(role)) {
            return res.status(400).json({ error: 'Invalid role. Must be: manufacturer, distributor, or pharmacy' });
        }

        // Check if wallet already connected
        const existingUser = await pool.query('SELECT * FROM users WHERE wallet_address = $1', [walletAddress.toLowerCase()]);
        
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

        // Create new user session
        const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Insert user into database
        const newUser = await pool.query(
            `INSERT INTO users 
             (wallet_address, role, email, company_name, session_id) 
             VALUES ($1, $2, $3, $4, $5) 
             RETURNING *`,
            [walletAddress.toLowerCase(), role, email, companyName, sessionId]
        );

        const userRecord = newUser.rows[0];
        
        // Cache session
        sessionCache.set(sessionId, userRecord);

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

        // Validate password
        const passwordValidation = validatePassword(password);
        if (!passwordValidation.valid) {
            return res.status(400).json({ error: passwordValidation.error });
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
        try {
            // Try to register with user-provided password
            registerResult = await callWaltAPI('POST', '/auth/register', {
                type: 'email',
                name: userRecord.company_name,
                email: waltEmail,
                password: password
            });
        } catch (registerError) {
            // If already registered, try to login with the provided password
            if (registerError?.response?.status === 409) {
                console.log('[Walt.id] User already exists, logging in...');
                registerResult = await callWaltAPI('POST', '/auth/login', {
                    type: 'email',
                    email: waltEmail,
                    password: password
                });
            } else {
                throw registerError;
            }
        }

        let sessionCookie = registerResult.cookie;

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
             SET did = $1, wallet_id = $2, walt_id_registered_at = CURRENT_TIMESTAMP 
             WHERE session_id = $3 
             RETURNING *`,
            [did, walletId, sessionId]
        );

        const updatedUserRecord = updatedUser.rows[0];
        
        // Update cache
        sessionCache.set(sessionId, updatedUserRecord);

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

        // Try cache first
        let userRecord = sessionCache.get(sessionId);
        
        // If not in cache, fetch from database
        if (!userRecord) {
            const userResult = await pool.query(
                'SELECT * FROM users WHERE session_id = $1',
                [sessionId]
            );

            if (userResult.rows.length === 0) {
                return res.status(401).json({ error: 'Invalid or expired session' });
            }

            userRecord = userResult.rows[0];
            sessionCache.set(sessionId, userRecord);
        }

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
            sessionCache.delete(sessionId);
            // Session stays in database for audit purposes but is effectively inactive
        }

        res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 5. HEALTH CHECK
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

// ===== START SERVER =====
async function startServer() {
    try {
        // Initialize database
        await initializeDatabase();
        
        app.listen(PORT, () => {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`  Supply Chain App - Multi-Account MetaMask Auth`);
            console.log(`${'='.repeat(60)}`);
            console.log(`\n✓ Server running on http://localhost:${PORT}`);
            console.log(`✓ Walt.id API: ${WALT_API}`);
            console.log(`✓ Ethereum RPC: ${SEPOLIA_RPC_URL ? 'configured' : 'NOT configured'}`);
            console.log(`✓ Contract: ${CONTRACT_ADDRESS || 'NOT configured'}`);
            console.log(`✓ Database: Connected (app-postgres on port ${process.env.APP_POSTGRES_DB_PORT || 5433})`);
            console.log(`\nAPI Endpoints:`);
            console.log(`  POST   /api/auth/connect-metamask   - Connect MetaMask wallet`);
            console.log(`  POST   /api/auth/register-walt      - Register in Walt.id (with password)`);
            console.log(`  GET    /api/auth/user-info          - Get current user info`);
            console.log(`  POST   /api/auth/logout             - Logout`);
            console.log(`  GET    /api/health                  - Health check`);
            console.log('\n');
        });
    } catch (error) {
        console.error('Failed to start server:', error.message);
        process.exit(1);
    }
}

startServer();

module.exports = app;
