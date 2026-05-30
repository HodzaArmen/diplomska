/**
 * auth-utils.js
 * Shared auth helpers for MetaMask session management
 */

async function disconnectMetaMask() {
    if (!window.ethereum) {
        return;
    }

    try {
        await window.ethereum.request({
            method: 'wallet_revokePermissions',
            params: [{ eth_accounts: {} }]
        });
    } catch (error) {
        console.warn('MetaMask disconnect:', error.message);
    }
}
