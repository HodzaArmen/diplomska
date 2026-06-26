/**
 * blockchain-write.js — strežniški podpis TX le ob CHAIN_AUTO_SIGN=true
 * Uporablja znane Anvil dev ključe za račune #0–#9 (Foundry privzeti).
 */

import { ethers } from 'ethers';
import { CONTRACT_ABI, getUserFromBlockchain, isContractDeployed } from './blockchain.js';

const ANVIL_DEV_KEYS = new Map([
    ['0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'],
    ['0x70997970c51812dc3a010c7d01b50e0d17dc79c8', '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'],
    ['0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc', '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'],
    ['0x90f79bf6eb2c4f870365e785982e1f101e93b906', '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6']
]);

export function isChainAutoSignEnabled() {
    if (process.env.CHAIN_AUTO_SIGN === 'true') return true;
    return false;
}

function resolvePrivateKey(walletAddress) {
    if (!walletAddress) return null;
    const key = ANVIL_DEV_KEYS.get(String(walletAddress).toLowerCase());
    return key || process.env.CHAIN_SIGNER_PRIVATE_KEY || null;
}

function getRpcUrl() {
    return process.env.CHAIN_RPC_URL || process.env.SEPOLIA_RPC_URL;
}

function getContractAddress() {
    return process.env.CONTRACT_ADDRESS;
}

async function getWriteContract(walletAddress) {
    const rpc = getRpcUrl();
    const address = getContractAddress();
    const pk = resolvePrivateKey(walletAddress);
    if (!rpc || !address || !pk) {
        throw new Error(`Strežniški podpis ni na voljo za ${walletAddress} (CHAIN_AUTO_SIGN / Anvil ključ)`);
    }
    const provider = new ethers.JsonRpcProvider(rpc);
    const signer = new ethers.Wallet(pk, provider);
    const contract = new ethers.Contract(address, CONTRACT_ABI, signer);
    return { contract, signer };
}

export function canAutoSignForWallet(walletAddress) {
    return isChainAutoSignEnabled() && Boolean(resolvePrivateKey(walletAddress));
}

export async function ensureUserRegisteredServer(walletAddress, did, role) {
    if (!canAutoSignForWallet(walletAddress)) {
        return { skipped: true };
    }
    if (!(await isContractDeployed())) {
        throw new Error('Smart contract ni deployan — zaženite scripts/deploy-anvil.ps1');
    }
    try {
        const existing = await getUserFromBlockchain(walletAddress);
        if (existing?.registered) {
            return { ok: true, alreadyRegistered: true };
        }
    } catch {
        // nadaljuj z registracijo
    }
    const { contract } = await getWriteContract(walletAddress);
    const tx = await contract.registerUser(did, role);
    const receipt = await tx.wait();
    return { ok: true, txHash: receipt.hash };
}

export async function registerMedicineServer(walletAddress, medicineId, ipfsHash, did = null, role = null) {
    if (!canAutoSignForWallet(walletAddress)) {
        return { skipped: true };
    }
    if (!(await isContractDeployed())) {
        throw new Error('Smart contract ni deployan — zaženite scripts/deploy-anvil.ps1');
    }
    if (did && role) {
        await ensureUserRegisteredServer(walletAddress, did, role);
    }
    const { contract } = await getWriteContract(walletAddress);
    const tx = await contract.registerMedicine(medicineId, ipfsHash);
    const receipt = await tx.wait();
    return { ok: true, txHash: receipt.hash };
}

export async function recordHandoffServer(walletAddress, payload) {
    if (!canAutoSignForWallet(walletAddress)) {
        return { skipped: true };
    }
    if (!(await isContractDeployed())) {
        throw new Error('Smart contract ni deployan — zaženite scripts/deploy-anvil.ps1');
    }
    const { contract } = await getWriteContract(walletAddress);
    const tx = await contract.recordHandoff(
        payload.medicineId,
        payload.deliveryId || '',
        payload.quantity,
        payload.counterpartyAddress,
        payload.counterpartyDid || '',
        payload.eventType,
        payload.vcRef || '',
        payload.newHolderAddress,
        payload.newHolderDid || ''
    );
    const receipt = await tx.wait();
    return { ok: true, txHash: receipt.hash };
}
