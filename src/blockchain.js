/**
 * blockchain.js — read-only Sepolia access (MetaMask podpisuje TX v brskalniku)
 */

import { ethers } from 'ethers';

const CONTRACT_ABI = [
    {
        inputs: [
            { internalType: 'string', name: '_did', type: 'string' },
            { internalType: 'string', name: '_role', type: 'string' }
        ],
        name: 'registerUser',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function'
    },
    {
        inputs: [
            { internalType: 'string', name: '_medicineId', type: 'string' },
            { internalType: 'string', name: '_ipfsHash', type: 'string' }
        ],
        name: 'registerMedicine',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function'
    },
    {
        inputs: [
            { internalType: 'string', name: '_medicineId', type: 'string' },
            { internalType: 'string', name: '_status', type: 'string' }
        ],
        name: 'updateMedicineStatus',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function'
    },
    {
        inputs: [
            { internalType: 'string', name: '_medicineId', type: 'string' },
            { internalType: 'string', name: '_deliveryId', type: 'string' },
            { internalType: 'uint256', name: '_quantity', type: 'uint256' },
            { internalType: 'address', name: '_counterparty', type: 'address' },
            { internalType: 'string', name: '_counterpartyDID', type: 'string' },
            { internalType: 'string', name: '_eventType', type: 'string' },
            { internalType: 'string', name: '_vcRef', type: 'string' },
            { internalType: 'address', name: '_newHolder', type: 'address' },
            { internalType: 'string', name: '_newHolderDID', type: 'string' }
        ],
        name: 'recordHandoff',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function'
    },
    {
        inputs: [{ internalType: 'address', name: '_wallet', type: 'address' }],
        name: 'getUser',
        outputs: [
            {
                components: [
                    { internalType: 'address', name: 'wallet', type: 'address' },
                    { internalType: 'string', name: 'did', type: 'string' },
                    { internalType: 'string', name: 'role', type: 'string' },
                    { internalType: 'bool', name: 'registered', type: 'bool' }
                ],
                internalType: 'struct SupplyChain.User',
                name: '',
                type: 'tuple'
            }
        ],
        stateMutability: 'view',
        type: 'function'
    },
    {
        inputs: [{ internalType: 'string', name: '_medicineId', type: 'string' }],
        name: 'getMedicine',
        outputs: [
            {
                components: [
                    { internalType: 'string', name: 'medicineId', type: 'string' },
                    { internalType: 'string', name: 'ipfsHash', type: 'string' },
                    { internalType: 'address', name: 'manufacturer', type: 'address' },
                    { internalType: 'uint256', name: 'createdAt', type: 'uint256' },
                    { internalType: 'string', name: 'status', type: 'string' },
                    { internalType: 'address', name: 'currentHolder', type: 'address' },
                    { internalType: 'string', name: 'currentHolderDID', type: 'string' }
                ],
                internalType: 'struct SupplyChain.Medicine',
                name: '',
                type: 'tuple'
            }
        ],
        stateMutability: 'view',
        type: 'function'
    },
    {
        inputs: [{ internalType: 'string', name: '_medicineId', type: 'string' }],
        name: 'getMedicineHistory',
        outputs: [
            {
                components: [
                    { internalType: 'string', name: 'medicineId', type: 'string' },
                    { internalType: 'address', name: 'from', type: 'address' },
                    { internalType: 'string', name: 'fromDID', type: 'string' },
                    { internalType: 'address', name: 'to', type: 'address' },
                    { internalType: 'string', name: 'toDID', type: 'string' },
                    { internalType: 'uint256', name: 'timestamp', type: 'uint256' },
                    { internalType: 'string', name: 'status', type: 'string' }
                ],
                internalType: 'struct SupplyChain.Transaction[]',
                name: '',
                type: 'tuple[]'
            }
        ],
        stateMutability: 'view',
        type: 'function'
    },
    {
        inputs: [{ internalType: 'string', name: '_medicineId', type: 'string' }],
        name: 'getMedicineHandoffs',
        outputs: [
            {
                components: [
                    { internalType: 'string', name: 'deliveryId', type: 'string' },
                    { internalType: 'uint256', name: 'quantity', type: 'uint256' },
                    { internalType: 'address', name: 'actor', type: 'address' },
                    { internalType: 'string', name: 'actorDID', type: 'string' },
                    { internalType: 'address', name: 'counterparty', type: 'address' },
                    { internalType: 'string', name: 'counterpartyDID', type: 'string' },
                    { internalType: 'uint256', name: 'timestamp', type: 'uint256' },
                    { internalType: 'string', name: 'eventType', type: 'string' },
                    { internalType: 'string', name: 'vcRef', type: 'string' }
                ],
                internalType: 'struct SupplyChain.Handoff[]',
                name: '',
                type: 'tuple[]'
            }
        ],
        stateMutability: 'view',
        type: 'function'
    }
];

/** Sepolia = 11155111, Anvil lokalno = 31337 (nastavi CHAIN_ID v .env) */
const CHAIN_ID = Number(process.env.CHAIN_ID || 11155111);
const SEPOLIA_CHAIN_ID = CHAIN_ID;

let provider = null;
let readContract = null;
let contractAddress = null;

function initializeBlockchainReadOnly(rpcUrl, address) {
    if (!rpcUrl || !address) {
        return null;
    }
    provider = new ethers.JsonRpcProvider(rpcUrl);
    contractAddress = address;
    readContract = new ethers.Contract(address, CONTRACT_ABI, provider);
    console.log(`✓ Blockchain read-only: ${address}`);
    return { provider, contract: readContract, address };
}

async function getUserFromBlockchain(walletAddress) {
    if (!readContract) {
        throw new Error('Blockchain not initialized');
    }
    try {
        const user = await readContract.getUser(walletAddress);
        return {
            wallet: user.wallet,
            did: user.did,
            role: user.role,
            registered: Boolean(user.registered)
        };
    } catch (error) {
        if (isEmptyChainReadError(error)) {
            return { wallet: walletAddress, did: '', role: '', registered: false };
        }
        throw error;
    }
}

function isEmptyChainReadError(error) {
    return error?.code === 'BAD_DATA'
        || error?.message?.includes('could not decode')
        || error?.message?.includes('value="0x"');
}

async function getMedicineFromBlockchain(medicineId) {
    if (!readContract) {
        throw new Error('Blockchain not initialized');
    }
    try {
        const medicine = await readContract.getMedicine(medicineId);
        if (!medicine?.medicineId) {
            return null;
        }
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
        if (isEmptyChainReadError(error)) {
            return null;
        }
        throw error;
    }
}

async function getMedicineHistory(medicineId) {
    if (!readContract) {
        throw new Error('Blockchain not initialized');
    }
    try {
        const history = await readContract.getMedicineHistory(medicineId);
        return history.map((tx) => ({
            medicineId: tx.medicineId,
            from: tx.from,
            fromDID: tx.fromDID,
            to: tx.to,
            toDID: tx.toDID,
            timestamp: Number(tx.timestamp),
            status: tx.status
        }));
    } catch (error) {
        if (isEmptyChainReadError(error)) {
            return [];
        }
        throw error;
    }
}

async function getMedicineHandoffsFromBlockchain(medicineId) {
    if (!readContract) {
        throw new Error('Blockchain not initialized');
    }
    try {
        const handoffs = await readContract.getMedicineHandoffs(medicineId);
        return handoffs.map((h) => ({
            deliveryId: h.deliveryId,
            quantity: Number(h.quantity),
            actor: h.actor,
            actorDID: h.actorDID,
            counterparty: h.counterparty,
            counterpartyDID: h.counterpartyDID,
            timestamp: Number(h.timestamp),
            eventType: h.eventType,
            vcRef: h.vcRef
        }));
    } catch (error) {
        if (error.code === 'BAD_DATA' || error.message?.includes('getMedicineHandoffs')) {
            return getMedicineHistory(medicineId).then((history) =>
                history.map((tx) => ({
                    deliveryId: '',
                    quantity: 0,
                    actor: tx.from,
                    actorDID: tx.fromDID,
                    counterparty: tx.to,
                    counterpartyDID: tx.toDID,
                    timestamp: tx.timestamp,
                    eventType: tx.status,
                    vcRef: ''
                }))
            );
        }
        throw error;
    }
}

function getBlockchainConfig() {
    return {
        contractAddress,
        chainId: CHAIN_ID,
        abi: CONTRACT_ABI
    };
}

async function isContractDeployed() {
    if (!provider || !contractAddress) {
        return false;
    }
    try {
        const code = await provider.getCode(contractAddress);
        return Boolean(code && code !== '0x');
    } catch {
        return false;
    }
}

function resetBlockchainRead() {
    provider = null;
    readContract = null;
    contractAddress = null;
    global.blockchainRead = null;
}

export {
    CONTRACT_ABI,
    CHAIN_ID,
    SEPOLIA_CHAIN_ID,
    initializeBlockchainReadOnly,
    getUserFromBlockchain,
    getMedicineFromBlockchain,
    getMedicineHistory,
    getMedicineHandoffsFromBlockchain,
    getBlockchainConfig,
    isContractDeployed,
    resetBlockchainRead
};
