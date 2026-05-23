/**
 * blockchain.js
 * Integration with Ethereum Sepolia using ethers.js v6
 * Handles all smart contract interactions
 */

const { ethers } = require('ethers');

// Contract ABI - functions that will be called
// This ABI matches the SupplyChain.sol smart contract
const CONTRACT_ABI = [
    {
        "inputs": [
            { "internalType": "string", "name": "_did", "type": "string" },
            { "internalType": "string", "name": "_role", "type": "string" }
        ],
        "name": "registerUser",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "string", "name": "_medicineId", "type": "string" },
            { "internalType": "string", "name": "_ipfsHash", "type": "string" }
        ],
        "name": "registerMedicine",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "string", "name": "_medicineId", "type": "string" },
            { "internalType": "string", "name": "_status", "type": "string" }
        ],
        "name": "updateMedicineStatus",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "string", "name": "_medicineId", "type": "string" }
        ],
        "name": "getMedicine",
        "outputs": [
            {
                "components": [
                    { "internalType": "string", "name": "medicineId", "type": "string" },
                    { "internalType": "string", "name": "ipfsHash", "type": "string" },
                    { "internalType": "address", "name": "manufacturer", "type": "address" },
                    { "internalType": "uint256", "name": "createdAt", "type": "uint256" },
                    { "internalType": "string", "name": "status", "type": "string" },
                    { "internalType": "address", "name": "currentHolder", "type": "address" },
                    { "internalType": "string", "name": "currentHolderDID", "type": "string" }
                ],
                "internalType": "struct SupplyChain.Medicine",
                "name": "",
                "type": "tuple"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "string", "name": "_medicineId", "type": "string" }
        ],
        "name": "getMedicineHistory",
        "outputs": [
            {
                "components": [
                    { "internalType": "string", "name": "medicineId", "type": "string" },
                    { "internalType": "address", "name": "from", "type": "address" },
                    { "internalType": "string", "name": "fromDID", "type": "string" },
                    { "internalType": "address", "name": "to", "type": "address" },
                    { "internalType": "string", "name": "toDID", "type": "string" },
                    { "internalType": "uint256", "name": "timestamp", "type": "uint256" },
                    { "internalType": "string", "name": "status", "type": "string" }
                ],
                "internalType": "struct SupplyChain.Transaction[]",
                "name": "",
                "type": "tuple[]"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    }
];

// Initialize provider and signer
let provider = null;
let signer = null;
let contract = null;

// ===== FUNCTION: Initialize blockchain connection =====
/**
 * Initializes ethers.js provider and signer
 * @param {string} rpcUrl - Ethereum RPC endpoint (e.g., Infura Sepolia URL)
 * @param {string} privateKey - Private key for signing transactions
 * @param {string} contractAddress - Deployed smart contract address
 */
function initializeBlockchain(rpcUrl, privateKey, contractAddress) {
    try {
        console.log(`\n[BLOCKCHAIN] Initializing ethers.js connection...`);

        // Create provider
        provider = new ethers.JsonRpcProvider(rpcUrl);
        console.log(`✓ Provider initialized (${rpcUrl})`);

        // Create wallet from private key
        const wallet = new ethers.Wallet(privateKey, provider);
        signer = wallet;
        console.log(`✓ Signer initialized: ${wallet.address}`);

        // Create contract instance
        contract = new ethers.Contract(contractAddress, CONTRACT_ABI, signer);
        console.log(`✓ Contract connected: ${contractAddress}`);

        return {
            provider,
            signer,
            contract,
            address: wallet.address
        };

    } catch (error) {
        console.error(`✗ Blockchain initialization failed: ${error.message}`);
        throw error;
    }
}

// ===== FUNCTION: Register user on blockchain =====
/**
 * Calls registerUser on smart contract to link address with DID
 * @param {string} did - User's walt.id DID
 * @param {string} role - User role (manufacturer, transporter, pharmacy)
 * @returns {Promise<Object>} - Transaction receipt
 */
async function registerUserOnBlockchain(did, role) {
    if (!contract) {
        throw new Error('Blockchain not initialized. Call initializeBlockchain first.');
    }

    try {
        console.log(`\n[BLOCKCHAIN] Registering user...`);
        console.log(`  DID: ${did}`);
        console.log(`  Role: ${role}`);

        const tx = await contract.registerUser(did, role);
        console.log(`  Transaction sent: ${tx.hash}`);

        const receipt = await tx.wait();
        console.log(`✓ User registered (block: ${receipt.blockNumber})`);

        return {
            success: true,
            alreadyRegistered: false,
            receipt
        };

    } catch (error) {
        const msg = String(error.message || '');
        if (msg.includes('User already registered')) {
            console.log(`ℹ User already registered on-chain, continuing...`);
            return {
                success: true,
                alreadyRegistered: true,
                receipt: null
            };
        }

        console.error(`✗ User registration failed: ${error.message}`);
        throw error;
    }
}

// ===== FUNCTION: Register medicine on blockchain =====
/**
 * Calls registerMedicine on smart contract
 * @param {string} medicineId - Unique medicine identifier
 * @param {string} ipfsHash - IPFS CID hash of product data
 * @returns {Promise<Object>} - Transaction receipt
 */
async function registerMedicineOnBlockchain(medicineId, ipfsHash) {
    if (!contract) {
        throw new Error('Blockchain not initialized. Call initializeBlockchain first.');
    }

    try {
        console.log(`\n[BLOCKCHAIN] Registering medicine...`);
        console.log(`  Medicine ID: ${medicineId}`);
        console.log(`  IPFS Hash: ${ipfsHash}`);

        const tx = await contract.registerMedicine(medicineId, ipfsHash);
        console.log(`  Transaction sent: ${tx.hash}`);

        const receipt = await tx.wait();
        console.log(`✓ Medicine registered (block: ${receipt.blockNumber})`);

        return receipt;

    } catch (error) {
        console.error(`✗ Medicine registration failed: ${error.message}`);
        throw error;
    }
}

// ===== FUNCTION: Update medicine status on blockchain =====
/**
 * Calls updateMedicineStatus on smart contract
 * @param {string} medicineId - Medicine ID to update
 * @param {string} status - New status (manufactured, in_transit, delivered)
 * @returns {Promise<Object>} - Transaction receipt
 */
async function updateMedicineStatusOnBlockchain(medicineId, status) {
    if (!contract) {
        throw new Error('Blockchain not initialized. Call initializeBlockchain first.');
    }

    try {
        console.log(`\n[BLOCKCHAIN] Updating medicine status...`);
        console.log(`  Medicine ID: ${medicineId}`);
        console.log(`  New Status: ${status}`);

        const tx = await contract.updateMedicineStatus(medicineId, status);
        console.log(`  Transaction sent: ${tx.hash}`);

        const receipt = await tx.wait();
        console.log(`✓ Status updated (block: ${receipt.blockNumber})`);

        return receipt;

    } catch (error) {
        console.error(`✗ Status update failed: ${error.message}`);
        throw error;
    }
}

// ===== FUNCTION: Get medicine from blockchain =====
/**
 * Retrieves medicine information from smart contract
 * @param {string} medicineId - Medicine ID to retrieve
 * @returns {Promise<Object>} - Medicine data
 */
async function getMedicineFromBlockchain(medicineId) {
    if (!contract) {
        throw new Error('Blockchain not initialized. Call initializeBlockchain first.');
    }

    try {
        console.log(`\n[BLOCKCHAIN] Retrieving medicine: ${medicineId}`);

        const medicine = await contract.getMedicine(medicineId);

        console.log(`✓ Medicine retrieved`);
        console.log(`  Status: ${medicine.status}`);
        console.log(`  Manufacturer: ${medicine.manufacturer}`);

        return {
            medicineId: medicine.medicineId,
            ipfsHash: medicine.ipfsHash,
            manufacturer: medicine.manufacturer,
            createdAt: Number(medicine.createdAt),
            status: medicine.status,
            currentHolder: medicine.currentHolder,
            currentHolderDID: medicine.currentHolderDID
        };

    } catch (error) {
        // Check if this is a data decoding error (empty return)
        if (error.code === 'BAD_DATA' && error.info && error.info.value === '0x') {
            console.error(`✗ Failed to retrieve medicine: ${error.message}`);
            console.error(`  Note: Contract may not have stored data for medicine ID: ${medicineId}`);
            console.error(`  This could mean: contract not deployed, or medicine not registered`);
        } else {
            console.error(`✗ Failed to retrieve medicine: ${error.message}`);
        }
        throw error;
    }
}

// ===== FUNCTION: Get medicine history =====
/**
 * Retrieves full transaction history for a medicine
 * @param {string} medicineId - Medicine ID
 * @returns {Promise<Array>} - Array of transactions
 */
async function getMedicineHistory(medicineId) {
    if (!contract) {
        throw new Error('Blockchain not initialized. Call initializeBlockchain first.');
    }

    try {
        console.log(`\n[BLOCKCHAIN] Retrieving history for: ${medicineId}`);

        const history = await contract.getMedicineHistory(medicineId);

        const normalizedHistory = history.map((tx) => ({
            medicineId: tx.medicineId,
            from: tx.from,
            fromDID: tx.fromDID,
            to: tx.to,
            toDID: tx.toDID,
            timestamp: Number(tx.timestamp),
            status: tx.status
        }));

        console.log(`✓ History retrieved (${normalizedHistory.length} transactions)`);
        return normalizedHistory;

    } catch (error) {
        // Check if this is a data decoding error (empty return)
        if (error.code === 'BAD_DATA' && error.info && error.info.value === '0x') {
            console.error(`✗ Failed to retrieve history: ${error.message}`);
            console.error(`  Note: Contract may not have history for medicine ID: ${medicineId}`);
            console.error(`  This could mean: contract not deployed, or medicine not registered`);
        } else {
            console.error(`✗ Failed to retrieve history: ${error.message}`);
        }
        throw error;
    }
}

// ===== FUNCTION: Get signer address =====
/**
 * Returns the address of the current signer
 * @returns {string} - Wallet address
 */
function getSignerAddress() {
    if (!signer) {
        throw new Error('Blockchain not initialized');
    }
    return signer.address;
}

// ===== EXPORT =====
module.exports = {
    initializeBlockchain,
    registerUserOnBlockchain,
    registerMedicineOnBlockchain,
    updateMedicineStatusOnBlockchain,
    getMedicineFromBlockchain,
    getMedicineHistory,
    getSignerAddress,
    CONTRACT_ABI
};
