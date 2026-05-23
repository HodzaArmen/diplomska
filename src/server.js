/**
 * server-new.js
 * Main Express server with MetaMask authentication and role-based dashboards
 * Supports multiple users/accounts with different roles: Manufacturer, Distributor, Pharmacy
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');

const app = express();

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public-new')));

// ===== CONFIGURATION =====
const WALT_API = process.env.WALT_ID_API_URL || 'http://localhost:7001/wallet-api';
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const PORT = process.env.PORT || 3000;

// ===== IN-MEMORY DATABASE =====
// In production, this should be a real database (PostgreSQL, MongoDB, etc.)
const users = new Map(); // Map of walletAddress -> userRecord
const sessions = new Map(); // Map of sessionId -> userRecord
let sessionCounter = 0;

// ===== INTERFACES & TYPES =====
/**
 * User Record Structure:
 * {
 *   walletAddress: string (MetaMask account),
 *   role: string ('manufacturer' | 'distributor' | 'pharmacy'),
 *   email: string (for Walt.id),
 *   did: string (Decentralized Identifier from Walt.id),
 *   walletId: string (Walt.id wallet ID),
 *   companyName: string,
 *   walletConnectedAt: Date,
 *   waltIdRegisteredAt: Date,
 *   sessionId: string
 * }
 */

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
        if (users.has(walletAddress)) {
            const existingUser = users.get(walletAddress);
            return res.status(200).json({
                success: true,
                message: 'Wallet already connected',
                sessionId: existingUser.sessionId,
                user: {
                    walletAddress: existingUser.walletAddress,
                    role: existingUser.role,
                    companyName: existingUser.companyName,
                    did: existingUser.did,
                    walletId: existingUser.walletId
                }
            });
        }

        // Create new user session
        const sessionId = `sess_${++sessionCounter}_${Date.now()}`;
        const userRecord = {
            walletAddress,
            role,
            email,
            companyName,
            walletConnectedAt: new Date(),
            sessionId,
            waltIdRegisteredAt: null,
            did: null,
            walletId: null
        };

        users.set(walletAddress, userRecord);
        sessions.set(sessionId, userRecord);

        res.json({
            success: true,
            message: 'MetaMask connected successfully',
            sessionId,
            user: {
                walletAddress,
                role,
                companyName
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
        const { sessionId } = req.body;

        if (!sessionId || !sessions.has(sessionId)) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }

        const userRecord = sessions.get(sessionId);

        // Check if already registered in Walt.id
        if (userRecord.did && userRecord.walletId) {
            return res.status(200).json({
                success: true,
                message: 'Already registered in Walt.id',
                user: {
                    walletAddress: userRecord.walletAddress,
                    did: userRecord.did,
                    walletId: userRecord.walletId
                }
            });
        }

        // Generate unique Walt.id account for this user
        const waltEmail = `${userRecord.walletAddress.toLowerCase()}_${userRecord.role}@diplomska.local`;
        const waltPassword = ethers.id(userRecord.walletAddress + Date.now()).substring(0, 16); // Generate from wallet

        console.log(`[Walt.id] Registering: ${waltEmail}`);

        let registerResult;
        try {
            // Try to register
            registerResult = await callWaltAPI('POST', '/auth/register', {
                type: 'email',
                name: userRecord.companyName,
                email: waltEmail,
                password: waltPassword
            });
        } catch (registerError) {
            // If already registered, try to login
            if (registerError?.response?.status === 409) {
                console.log('[Walt.id] User already exists, logging in...');
                registerResult = await callWaltAPI('POST', '/auth/login', {
                    type: 'email',
                    email: waltEmail,
                    password: waltPassword
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

        // Update user record
        userRecord.did = did;
        userRecord.walletId = walletId;
        userRecord.waltIdRegisteredAt = new Date();

        console.log(`✓ User registered in Walt.id: ${waltEmail}`);
        console.log(`✓ DID: ${did}`);
        console.log(`✓ Wallet ID: ${walletId}`);

        res.json({
            success: true,
            message: 'User registered in Walt.id successfully',
            user: {
                walletAddress: userRecord.walletAddress,
                role: userRecord.role,
                companyName: userRecord.companyName,
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
app.get('/api/auth/user-info', (req, res) => {
    try {
        const { sessionId } = req.query;

        if (!sessionId || !sessions.has(sessionId)) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }

        const userRecord = sessions.get(sessionId);
        res.json({
            success: true,
            user: {
                walletAddress: userRecord.walletAddress,
                role: userRecord.role,
                companyName: userRecord.companyName,
                email: userRecord.email,
                did: userRecord.did,
                walletId: userRecord.walletId,
                walletConnectedAt: userRecord.walletConnectedAt,
                waltIdRegisteredAt: userRecord.waltIdRegisteredAt
            }
        });
    } catch (error) {
        console.error('Get user info error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 4. LOGOUT - Destroy session
app.post('/api/auth/logout', (req, res) => {
    try {
        const { sessionId } = req.body;

        if (sessionId && sessions.has(sessionId)) {
            const userRecord = sessions.get(sessionId);
            sessions.delete(sessionId);
            // Keep user in users map for potential reconnection
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
            ethereum: SEPOLIA_RPC_URL ? 'configured' : 'not configured'
        }
    });
});

// ===== START SERVER =====
app.listen(PORT, () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  Supply Chain App - Multi-Account MetaMask Auth`);
    console.log(`${'='.repeat(60)}`);
    console.log(`\n✓ Server running on http://localhost:${PORT}`);
    console.log(`✓ Walt.id API: ${WALT_API}`);
    console.log(`✓ Ethereum RPC: ${SEPOLIA_RPC_URL ? 'configured' : 'NOT configured'}`);
    console.log(`✓ Contract: ${CONTRACT_ADDRESS || 'NOT configured'}`);
    console.log(`\nAPI Endpoints:`);
    console.log(`  POST   /api/auth/connect-metamask   - Connect MetaMask wallet`);
    console.log(`  POST   /api/auth/register-walt      - Register in Walt.id`);
    console.log(`  GET    /api/auth/user-info          - Get current user info`);
    console.log(`  POST   /api/auth/logout             - Logout`);
    console.log(`  GET    /api/health                  - Health check`);
    console.log('\n');
});

module.exports = app;
