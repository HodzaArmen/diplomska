/**
 * blockchain-metamask.js — MetaMask podpis za SupplyChain (msg.sender = pravi udeleženec)
 */

const SEPOLIA_CHAIN_ID = 11155111;
const SEPOLIA_CHAIN_ID_HEX = '0xaa36a7';

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
    _config = data;
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

async function ensureSepoliaNetwork() {
    const provider = await getMetaMaskProvider();
    const chainId = await provider.request({ method: 'eth_chainId' });
    if (chainId === SEPOLIA_CHAIN_ID_HEX) return;

    try {
        await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: SEPOLIA_CHAIN_ID_HEX }]
        });
    } catch (error) {
        if (error.code === 4902) {
            await provider.request({
                method: 'wallet_addEthereumChain',
                params: [{
                    chainId: SEPOLIA_CHAIN_ID_HEX,
                    chainName: 'Sepolia',
                    nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
                    rpcUrls: ['https://rpc.sepolia.org']
                }]
            });
        } else {
            throw new Error('Preklopite MetaMask na Sepolia testno omrežje');
        }
    }
}

async function getContract() {
    if (_contract) return _contract;
    const config = await loadBlockchainConfig();
    await ensureSepoliaNetwork();

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
}

async function isUserRegisteredOnChain(walletAddress) {
    const config = await loadBlockchainConfig();
    const ethersLib = window.ethers;
    const provider = new ethersLib.BrowserProvider(window.ethereum);
    const contract = new ethersLib.Contract(config.contractAddress, config.abi, provider);
    const user = await contract.getUser(walletAddress);
    return Boolean(user.registered);
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
    await getConnectedAccount();
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

async function ensureOnChainUser(sessionId, did, role) {
    if (!sessionId || !did || !role || !window.ethereum) {
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
        console.warn('On-chain registracija:', error.message);
        return { ok: false, error: error.message };
    }
}

async function signMedicineAndConfirm(sessionId, medicineId, ipfsHash) {
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
    SEPOLIA_CHAIN_ID,
    loadBlockchainConfig,
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
    resetContractCache
};
