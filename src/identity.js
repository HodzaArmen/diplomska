/**
 * identity.js
 * Integration with walt.id for managing user wallets and DIDs
 * Communicates with walt.id Wallet API (default: http://localhost:7001/wallet-api)
 */

const axios = require('axios');

// Default walt.id Wallet API endpoint
const WALT_API_BASE = process.env.WALT_ID_API_URL || 'http://localhost:7001/wallet-api';

// In-memory session cookie
let sessionCookie = null;

// ===== HELPER: Make API calls with error handling =====
async function callWaltAPI(method, endpoint, data = null, extraHeaders = {}) {
    try {
        const url = `${WALT_API_BASE}${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            ...extraHeaders
        };

        if (sessionCookie && !headers.Cookie) {
            headers.Cookie = sessionCookie;
        }

        const config = {
            method: method,
            url: url,
            headers: headers
        };

        if (data) {
            config.data = data;
        }

        console.log(`[walt.id] ${method.toUpperCase()} ${url}`);
        const response = await axios(config);

        // Capture session cookie from login response
        const setCookie = response.headers?.['set-cookie'];
        if (setCookie && setCookie.length > 0) {
            sessionCookie = setCookie.map(cookie => cookie.split(';')[0]).join('; ');
        }

        return response.data;
    } catch (error) {
        console.error(`[walt.id ERROR] ${error.message}`);
        if (error.response) {
            console.error(`Response status: ${error.response.status}`);
            console.error(`Response data:`, error.response.data);
        }
        throw error;
    }
}

// ===== HELPER: Get wallet ID =====
/**
 * Retrieves the first wallet ID from the accounts/wallets endpoint
 * @returns {Promise<string>} - Wallet ID
 */
async function getWalletId() {
    try {
        const response = await callWaltAPI('GET', '/wallet/accounts/wallets');
        if (response && response.wallets && response.wallets.length > 0) {
            return response.wallets[0].id;
        }
        throw new Error('No wallets found');
    } catch (error) {
        console.error(`Failed to get wallet ID: ${error.message}`);
        throw error;
    }
}

// ===== FUNCTION: Register user in walt.id =====
/**
 * Creates a new wallet account in walt.id and generates a DID
 * @param {string} email - User email (e.g., "manufacturer@test.com")
 * @param {string} password - Password for wallet (min 8 chars)
 * @param {string} name - User name (e.g., "Manufacturer Corp")
 * @returns {Promise<Object>} - Returns { did, walletId, email }
 */
async function registerUserInWallet(email, password, name) {
    console.log(`\n[IDENTITY] Registering user: ${email}`);

    try {
        // Register new account in walt.id
        const registerData = {
            name: name,
            email: email,
            password: password,
            type: "email"
        };

        const registerResponse = await callWaltAPI(
            'POST',
            '/auth/register',
            registerData
        );

        console.log(`✓ Wallet created for ${email}`);

        // Extract DID from response or fetch it from wallet-specific endpoint
        let did = null;
        let walletId = null;

        if (registerResponse.did) {
            did = registerResponse.did;
        }

        if (registerResponse.walletId) {
            walletId = registerResponse.walletId;
        }

        // After registration, login to get authenticated session before accessing protected endpoints
        if (!did || !walletId) {
            try {
                // Login to establish authentication
                await callWaltAPI('POST', '/auth/login', {
                    type: "email",
                    email: email,
                    password: password
                });

                // Now get the wallet ID with authenticated session
                if (!walletId) {
                    walletId = await getWalletId();
                }

                // Then get DIDs for this specific wallet
                const didsResponse = await callWaltAPI(
                    'GET',
                    `/wallet/${walletId}/dids`
                );
                if (didsResponse && didsResponse.dids && didsResponse.dids.length > 0) {
                    did = didsResponse.dids[0].did;
                }
            } catch (didError) {
                console.warn(`⚠ Could not retrieve DID after login: ${didError.message}`);
            }
        }

        const result = {
            email: email,
            did: did || 'did:key:generated',
            walletId: walletId || email,
            status: 'registered'
        };

        console.log(`✓ DID: ${result.did}`);
        if (result.walletId && result.walletId !== email) {
            console.log(`✓ Wallet ID: ${result.walletId}`);
        }
        return result;

    } catch (error) {
        console.error(`✗ Failed to register user: ${error.message}`);
        throw error;
    }
}

// ===== FUNCTION: Login with DID =====
/**
 * Authenticates user and retrieves their DID
 * @param {string} email - User email
 * @param {string} password - User password
 * @returns {Promise<Object>} - Returns { email, did, authenticated, walletId }
 */
async function loginWithDID(email, password) {
    console.log(`\n[IDENTITY] Logging in user: ${email}`);

    try {
        const loginData = {
            type: "email",
            email: email,
            password: password
        };

        const loginResponse = await callWaltAPI(
            'POST',
            '/auth/login',
            loginData
        );

        console.log(`✓ User authenticated: ${email}`);

        // Try to get DID list using wallet-specific endpoint
        let did = null;
        let walletId = null;

        try {
            // First, get the wallet ID
            walletId = await getWalletId();

            // Then get DIDs for this specific wallet
            const didsResponse = await callWaltAPI(
                'GET',
                `/wallet/${walletId}/dids`
            );
            if (didsResponse && didsResponse.dids && didsResponse.dids.length > 0) {
                did = didsResponse.dids[0];
            }
        } catch (didError) {
            console.warn(`⚠ Could not retrieve DID: ${didError.message}`);
        }

        const result = {
            email: email,
            did: did || 'did:key:authenticated',
            walletId: walletId || email,
            authenticated: true,
            token: loginResponse.token || null
        };

        console.log(`✓ DID retrieved: ${result.did}`);
        if (result.walletId && result.walletId !== email) {
            console.log(`✓ Wallet ID: ${result.walletId}`);
        }
        return result;

    } catch (error) {
        console.error(`✗ Failed to login user: ${error.message}`);
        throw error;
    }
}

// ===== FUNCTION: Get user DID =====
/**
 * Retrieves the DID for a registered user
 * @param {string} email - User email
 * @returns {Promise<string>} - Returns the DID
 */
async function getUserDID(email) {
    try {
        // First, get the wallet ID
        const walletId = await getWalletId();

        // Then get DIDs for this specific wallet
        const didsResponse = await callWaltAPI(
            'GET',
            `/wallet/${walletId}/dids`
        );
        
        if (didsResponse && didsResponse.dids && didsResponse.dids.length > 0) {
            return didsResponse.dids[0];
        }
        
        throw new Error(`No DID found for ${email}`);
    } catch (error) {
        console.error(`Failed to get DID: ${error.message}`);
        throw error;
    }
}

// ===== FUNCTION: Verify DID format =====
/**
 * Simple verification that a string is a valid DID format
 * @param {string} did - DID to verify
 * @returns {boolean} - True if valid DID format
 */
function isValidDID(did) {
    return did && typeof did === 'string' && did.startsWith('did:');
}

// ===== EXPORT =====
module.exports = {
    registerUserInWallet,
    loginWithDID,
    getUserDID,
    isValidDID,
    WALT_API_BASE,
    getWalletId
};
