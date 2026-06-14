/**
 * app.js - Frontend logic for user authentication and MetaMask integration
 * Handles user registration, login, session management, and wallet connection
 * Communicates with backend API for authentication and user info
 * Manages UI state for authentication flow and error handling
 */

let currentUser = null;
let currentSessionId = null;
let currentWalletAddress = null;
let walletCheck = null;
let authMode = 'login';

document.addEventListener('DOMContentLoaded', initializeApp);

function attachEventListeners() {
    document.getElementById('btn-connect-metamask').addEventListener('click', connectMetaMask);
    document.getElementById('btn-register-complete').addEventListener('click', completeRegistration);
    document.getElementById('btn-login').addEventListener('click', loginExistingUser);
    document.getElementById('password-confirm')?.addEventListener('input', validatePasswordsMatch);
    document.getElementById('btn-logout')?.addEventListener('click', logout);
    document.getElementById('tab-login')?.addEventListener('click', () => setAuthMode('login'));
    document.getElementById('tab-register')?.addEventListener('click', () => setAuthMode('register'));
}

async function initializeApp() {
    const sessionId = sessionStorage.getItem('sessionId');
    if (sessionId) {
        try {
            const v = await fetch(`/api/auth/validate-session?sessionId=${encodeURIComponent(sessionId)}`);
            if (v.ok && (await v.json()).valid) {
                const userInfo = await getUserInfo(sessionId);
                if (userInfo.user) {
                    currentUser = userInfo.user;
                    currentSessionId = sessionId;
                    sessionStorage.setItem('user', JSON.stringify(currentUser));
                    redirectToRoleDashboard();
                    return;
                }
            }
        } catch (_) { /* */ }
        sessionStorage.clear();
    }
    showRegistration();
    attachEventListeners();
}

function setAuthMode(mode) {
    authMode = mode;
    document.getElementById('tab-login')?.classList.toggle('active', mode === 'login');
    document.getElementById('tab-register')?.classList.toggle('active', mode === 'register');
    if (currentWalletAddress) showAuthForm();
}

function showRegistration() {
    document.getElementById('progress-container').style.display = 'block';
    document.getElementById('auth-mode-tabs').style.display = 'none';
    showPhase(1);
}

function showPhase(n) {
    document.getElementById('phase-1').style.display = n === 1 ? 'block' : 'none';
    document.getElementById('phase-2-register').style.display = 'none';
    document.getElementById('phase-2-login').style.display = 'none';
    document.getElementById('step-1').classList.toggle('active', n >= 1);
    document.getElementById('step-1').classList.toggle('completed', n > 1);
    document.getElementById('step-2').classList.toggle('active', n >= 2);
}

function showAuthForm() {
    showPhase(2);
    document.getElementById('auth-mode-tabs').style.display = 'flex';
    const useLogin = authMode === 'login' || (walletCheck?.registered && walletCheck?.hasWaltId);
    if (walletCheck?.registered && walletCheck?.hasWaltId) {
        authMode = 'login';
        document.getElementById('tab-login')?.classList.add('active');
        document.getElementById('tab-register')?.classList.remove('active');
    }
    document.getElementById('phase-2-login').style.display = useLogin ? 'block' : 'none';
    document.getElementById('phase-2-register').style.display = useLogin ? 'none' : 'block';
    const email = walletCheck?.user?.waltEmail || walletCheck?.user?.email || '';
    if (email) {
        document.getElementById('walt-login-email').value = email;
        document.getElementById('user-email').value = email;
    }
}

function getDashboardUrl(role) {
    return {
        manufacturer: '/manufacturer',
        distributor: '/distributor',
        pharmacy: '/pharmacy',
        regulator: '/regulator'
    }[role] || '/';
}

function redirectToRoleDashboard() {
    if (currentUser?.role) window.location.href = getDashboardUrl(currentUser.role);
}

async function connectMetaMask() {
    try {
        clearError('metamask-error');
        if (!window.ethereum) {
            showError('metamask-error', 'MetaMask ni nameščen.');
            return;
        }
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        currentWalletAddress = accounts[0];
        document.getElementById('wallet-preview').innerHTML =
            `<div class="wallet-info"><p class="label">Denarnica</p><p class="address">${currentWalletAddress}</p></div>`;

        const checkResponse = await fetch(`/api/auth/check-wallet?walletAddress=${encodeURIComponent(currentWalletAddress)}`);
        walletCheck = await checkResponse.json();
        if (!checkResponse.ok) throw new Error('Napaka pri preverjanju denarnice');

        if (walletCheck.registered && walletCheck.hasWaltId) {
            setAuthMode('login');
        } else {
            setAuthMode('register');
            if (walletCheck.registered && walletCheck.user) {
                document.getElementById('role-select').value = walletCheck.user.role || '';
                document.getElementById('company-name').value = walletCheck.user.companyName || '';
                document.getElementById('user-email').value = walletCheck.user.waltEmail || walletCheck.user.email || '';
            }
        }
        showAuthForm();
    } catch (e) {
        showError('metamask-error', e.message);
    }
}

async function loginExistingUser() {
    try {
        clearError('login-error');
        const waltEmail = document.getElementById('walt-login-email').value.trim();
        const password = document.getElementById('walt-login-password').value;
        if (!currentWalletAddress || !waltEmail || !password) {
            showError('login-error', 'Povežite MetaMask in vpišite email + geslo.');
            return;
        }
        showLoading(true, 'Prijava...');
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ walletAddress: currentWalletAddress, waltEmail, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        currentSessionId = data.sessionId;
        currentUser = data.user;
        sessionStorage.setItem('sessionId', currentSessionId);
        sessionStorage.setItem('user', JSON.stringify(currentUser));
        if (data.needsOnChainRegistration && window.BlockchainMetaMask) {
            updateLoadingStatus('MetaMask (Sepolia)...');
            await BlockchainMetaMask.ensureOnChainUser(
                currentSessionId,
                data.onChainRegistration?.did || currentUser.did,
                data.onChainRegistration?.role || currentUser.role
            );
        }
        showLoading(false);
        redirectToRoleDashboard();
    } catch (e) {
        showLoading(false);
        showError('login-error', e.message);
    }
}

async function completeRegistration() {
    try {
        clearError('registration-error');
        const role = document.getElementById('role-select').value;
        const companyName = document.getElementById('company-name').value.trim();
        const email = document.getElementById('user-email').value.trim();
        const password = document.getElementById('password').value;
        const passwordConfirm = document.getElementById('password-confirm').value;

        if (!currentWalletAddress) return showError('registration-error', 'Najprej MetaMask.');
        if (!role || !companyName || !email || !password) return showError('registration-error', 'Izpolnite vsa polja.');
        if (password.length < 8) return showError('registration-error', 'Geslo: min. 8 znakov.');
        if (password !== passwordConfirm) return showError('registration-error', 'Gesli se ne ujemata.');
        if (walletCheck?.registered && walletCheck?.hasWaltId) {
            return showError('registration-error', 'Uporabite zavihek Prijava.');
        }

        showLoading(true, 'Registracija...');
        const mmRes = await fetch('/api/auth/connect-metamask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ walletAddress: currentWalletAddress, role, companyName, email })
        });
        const mmData = await mmRes.json();
        if (!mmRes.ok) throw new Error(mmData.error);
        if (mmData.alreadyRegistered) throw new Error('Denarnica že obstaja — Prijava.');

        currentSessionId = mmData.sessionId;
        updateLoadingStatus('Walt.id...');
        const waltRes = await fetch('/api/auth/register-walt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: currentSessionId, waltEmail: email, password })
        });
        const waltData = await waltRes.json();
        if (!waltRes.ok) throw new Error(waltData.error);
        currentUser = waltData.user;
        sessionStorage.setItem('sessionId', currentSessionId);
        sessionStorage.setItem('user', JSON.stringify(currentUser));
        if (waltData.needsOnChainRegistration && window.BlockchainMetaMask) {
            updateLoadingStatus('MetaMask (Sepolia)...');
            await BlockchainMetaMask.ensureOnChainUser(
                currentSessionId,
                waltData.onChainRegistration?.did || currentUser.did,
                waltData.onChainRegistration?.role || currentUser.role
            );
        }
        showLoading(false);
        redirectToRoleDashboard();
    } catch (e) {
        showLoading(false);
        showError('registration-error', e.message);
    }
}

async function getUserInfo(sessionId) {
    const r = await fetch(`/api/auth/user-info?sessionId=${encodeURIComponent(sessionId)}`);
    if (!r.ok) throw new Error('user-info');
    return r.json();
}

async function logout() {
    try {
        if (currentSessionId) {
            await fetch('/api/auth/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: currentSessionId })
            });
        }
        await disconnectMetaMask?.();
    } finally {
        sessionStorage.clear();
        location.href = '/';
    }
}

function validatePasswordsMatch() {
    const p = document.getElementById('password').value;
    const c = document.getElementById('password-confirm').value;
    const el = document.getElementById('password-match-error');
    if (c && p !== c) { el.style.display = 'block'; return false; }
    el.style.display = 'none';
    return true;
}

function showError(id, msg) {
    const el = document.getElementById(id);
    el.textContent = msg;
    el.style.display = 'block';
}

function clearError(id) {
    const el = document.getElementById(id);
    el.textContent = '';
    el.style.display = 'none';
}

function showLoading(show, status = 'Prosimo počakajte...') {
    document.getElementById('registration-loading').style.display = show ? 'block' : 'none';
    document.getElementById('loading-status').textContent = status;
    document.getElementById('btn-register-complete').disabled = show;
    document.getElementById('btn-login').disabled = show;
}

function updateLoadingStatus(s) {
    document.getElementById('loading-status').textContent = s;
}

if (window.ethereum) {
    window.ethereum.on('accountsChanged', (accounts) => {
        if (!accounts.length) logout();
    });
}
