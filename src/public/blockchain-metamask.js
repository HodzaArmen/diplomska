/**
 * blockchain-metamask.js — MetaMask podpis za SupplyChain (msg.sender = pravi udeleženec)
 * Omrežje (Sepolia / Anvil) pride iz GET /api/blockchain/config
 */

let _config = null;
let _contract = null;

async function loadBlockchainConfig() {
    if (_config) return _config;
    const res = await fetch('/api/blockchain/config');
    if (!res.ok) {
        throw new Error('Blockchain ni konfiguriran na strežniku');
    }
    const data = await res.json();
    if (!data.success || !data.contractAddress) {
        throw new Error(data.error || 'Manjka CONTRACT_ADDRESS');
    }
    _config = {
        ...data,
        chainIdHex: data.chainIdHex || `0x${Number(data.chainId).toString(16)}`
    };
    return _config;
}

async function getMetaMaskProvider() {
    if (!window.ethereum) {
        throw new Error('MetaMask ni nameščen');
    }
    return window.ethereum;
}

async function getConnectedAccount() {
    const provider = await getMetaMaskProvider();
    const accounts = await provider.request({ method: 'eth_accounts' });
    if (!accounts?.length) {
        throw new Error('MetaMask ni povezan — najprej povežite denarnico');
    }
    return accounts[0];
}

async function ensureTargetNetwork() {
    const config = await loadBlockchainConfig();
    const provider = await getMetaMaskProvider();
    const current = await provider.request({ method: 'eth_chainId' });
    if (current.toLowerCase() === config.chainIdHex.toLowerCase()) return;

    const rpcUrl = config.rpcUrl || 'http://127.0.0.1:8545';
    const networkName = config.network || `Chain ${config.chainId}`;

    try {
        await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: config.chainIdHex }]
        });
    } catch (error) {
        if (isMetaMaskUserRejection(error)) {
            throw error;
        }
        if (error.code === 4902) {
            try {
                await provider.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                        chainId: config.chainIdHex,
                        chainName: networkName,
                        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                        rpcUrls: [rpcUrl]
                    }]
                });
            } catch (addError) {
                if (isMetaMaskUserRejection(addError)) {
                    throw addError;
                }
                throw new Error(`Preklopite MetaMask na ${networkName} (chainId ${config.chainId})`);
            }
        } else {
            throw new Error(`Preklopite MetaMask na ${networkName} (chainId ${config.chainId})`);
        }
    }
}

/** @deprecated uporabi ensureTargetNetwork */
async function ensureSepoliaNetwork() {
    return ensureTargetNetwork();
}

async function getContract() {
    if (_contract) return _contract;
    const config = await loadBlockchainConfig();
    await ensureTargetNetwork();

    const ethersLib = window.ethers;
    if (!ethersLib) {
        throw new Error('ethers.js ni naložen');
    }

    const provider = new ethersLib.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    _contract = new ethersLib.Contract(config.contractAddress, config.abi, signer);
    return _contract;
}

function resetContractCache() {
    _contract = null;
    _config = null;
}

async function isUserRegisteredOnChain(walletAddress) {
    const config = await loadBlockchainConfig();
    const ethersLib = window.ethers;
    const provider = new ethersLib.BrowserProvider(window.ethereum);
    const code = await provider.getCode(config.contractAddress);
    if (!code || code === '0x') {
        throw new Error('Pametna pogodba ni deployana na tej verigi. Počakajte na scripts-deploy-anvil ali zaženite deploy-anvil.ps1.');
    }
    const contract = new ethersLib.Contract(config.contractAddress, config.abi, provider);
    try {
        const user = await contract.getUser(walletAddress);
        return Boolean(user.registered);
    } catch (error) {
        if (error?.code === 'BAD_DATA' || String(error?.message || '').includes('could not decode')) {
            return false;
        }
        throw error;
    }
}

async function registerUserOnChain(did, role) {
    if (!did || !role) {
        throw new Error('Manjka DID ali vloga za on-chain registracijo');
    }
    await getConnectedAccount();
    const contract = await getContract();

    try {
        const already = await contract.getUser(await (await contract.runner.getAddress()));
        if (already.registered) {
            return { ok: true, alreadyRegistered: true, txHash: null };
        }
    } catch {
        // nadaljuj
    }

    const tx = await contract.registerUser(did, role);
    const receipt = await tx.wait();
    return { ok: true, txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

async function registerMedicineOnChain(medicineId, ipfsHash) {
    if (!medicineId || !ipfsHash) {
        throw new Error('Manjka medicineId ali ipfsHash');
    }
    const account = await getConnectedAccount();
    const registered = await isUserRegisteredOnChain(account);
    if (!registered) {
        throw new Error(
            'Wallet ni registriran na verigi. Odprite Profil → On-chain registracija (registerUser), nato poskusite znova.'
        );
    }
    const contract = await getContract();
    const tx = await contract.registerMedicine(medicineId, ipfsHash);
    const receipt = await tx.wait();
    return { ok: true, txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

async function recordHandoffOnChain({
    medicineId,
    deliveryId,
    quantity,
    counterpartyAddress,
    counterpartyDid,
    eventType,
    vcRef,
    newHolderAddress,
    newHolderDid
}) {
    await getConnectedAccount();
    const contract = await getContract();
    const tx = await contract.recordHandoff(
        medicineId,
        deliveryId || '',
        quantity,
        counterpartyAddress,
        counterpartyDid || '',
        eventType,
        vcRef || '',
        newHolderAddress,
        newHolderDid || ''
    );
    const receipt = await tx.wait();
    return { ok: true, txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

async function confirmBlockchainTx(sessionId, payload) {
    const res = await fetch('/api/blockchain/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, ...payload })
    });
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error || 'Potrditev blockchain TX ni uspela');
    }
    return data;
}

const META_MASK_REJECTED_MSG = 'Napaka pri odobritvi transakcije v MetaMask.';

function isMetaMaskUserRejection(error) {
    if (!error) return false;
    const code = error.code ?? error.info?.error?.code ?? error.error?.code;
    if (code === 4001 || code === '4001' || code === 'ACTION_REJECTED') return true;
    const msg = [error.message, error.reason, error.shortMessage, error.info?.error?.message]
        .filter(Boolean)
        .join(' ');
    return /user rejected|user denied|denied transaction|request rejected|rejected the request|preklic/i.test(msg);
}

function formatOnChainError(error) {
    if (isMetaMaskUserRejection(error)) {
        return META_MASK_REJECTED_MSG;
    }
    return error?.message || 'On-chain registracija ni uspela';
}

async function ensureOnChainUser(sessionId, did, role, options = {}) {
    const { required = false } = options;
    if (!sessionId || !did || !role || !window.ethereum) {
        if (required) {
            throw new Error('On-chain registracija ni mogoča — manjka seja, DID ali MetaMask.');
        }
        return { ok: false, skipped: true };
    }
    try {
        const account = await getConnectedAccount();
        const registered = await isUserRegisteredOnChain(account);
        if (registered) {
            return { ok: true, alreadyRegistered: true };
        }
        const result = await registerUserOnChain(did, role);
        if (result.txHash) {
            await confirmBlockchainTx(sessionId, {
                type: 'register_user',
                txHash: result.txHash
            });
        }
        return result;
    } catch (error) {
        const message = formatOnChainError(error);
        if (required) {
            throw new Error(message);
        }
        console.warn('On-chain registracija:', message);
        return { ok: false, error: message };
    }
}

async function signMedicineAndConfirm(sessionId, medicineId, ipfsHash, did, role) {
    const reg = await ensureOnChainUser(sessionId, did, role);
    if (reg?.error) {
        throw new Error(`On-chain registracija uporabnika ni uspela: ${reg.error}`);
    }
    const account = await getConnectedAccount();
    const registered = await isUserRegisteredOnChain(account);
    if (!registered) {
        throw new Error(
            'Wallet še ni na verigi. Potrdite registerUser v MetaMask (Profil → On-chain registracija).'
        );
    }
    const result = await registerMedicineOnChain(medicineId, ipfsHash);
    const confirmed = await confirmBlockchainTx(sessionId, {
        type: 'register_medicine',
        txHash: result.txHash,
        medicineId
    });
    return { ...result, confirmed };
}

async function signHandoffAndConfirm(sessionId, chainHandoff, historyAction) {
    if (!chainHandoff?.needsBlockchain || !chainHandoff.payload) {
        return { ok: false, skipped: true };
    }
    const result = await recordHandoffOnChain(chainHandoff.payload);
    const confirmed = await confirmBlockchainTx(sessionId, {
        type: 'handoff',
        txHash: result.txHash,
        medicineId: chainHandoff.payload.medicineId,
        deliveryId: chainHandoff.payload.deliveryId,
        historyAction
    });
    return { ...result, confirmed };
}

window.BlockchainMetaMask = {
    loadBlockchainConfig,
    ensureTargetNetwork,
    ensureSepoliaNetwork,
    getConnectedAccount,
    isUserRegisteredOnChain,
    registerUserOnChain,
    registerMedicineOnChain,
    recordHandoffOnChain,
    confirmBlockchainTx,
    ensureOnChainUser,
    signMedicineAndConfirm,
    signHandoffAndConfirm,
    resetContractCache,
    isMetaMaskUserRejection,
    META_MASK_REJECTED_MSG
};
