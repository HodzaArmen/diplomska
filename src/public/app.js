/**
 * app.js - Frontend logic for user authentication and MetaMask integration
 */

let currentUser = null;
let currentSessionId = null;
let currentWalletAddress = null;
let walletCheck = null;
let authMode = 'register';

const MM_REJECTED_MSG = window.BlockchainMetaMask?.META_MASK_REJECTED_MSG
    || 'Napaka pri odobritvi transakcije v MetaMask.';

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
            const data = v.ok ? await v.json() : { valid: false };
            if (data.valid && data.readyForDashboard && data.user) {
                currentUser = data.user;
                currentSessionId = sessionId;
                sessionStorage.setItem('user', JSON.stringify(currentUser));
                redirectToRoleDashboard();
                return;
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

function isPendingOnChainRegistration() {
    return Boolean(walletCheck?.registered && walletCheck?.hasWaltId && walletCheck?.needsOnChainConfirmation);
}

function showAuthForm(options = {}) {
    const { forceRegister = false, forceLogin = false } = options;
    showPhase(2);
    document.getElementById('auth-mode-tabs').style.display = 'flex';

    let useLogin;
    if (forceRegister) {
        useLogin = false;
        authMode = 'register';
    } else if (forceLogin) {
        useLogin = true;
        authMode = 'login';
    } else if (isPendingOnChainRegistration()) {
        useLogin = false;
        authMode = 'register';
    } else {
        useLogin = authMode === 'login' || (walletCheck?.registered && walletCheck?.hasWaltId);
    }

    document.getElementById('tab-login')?.classList.toggle('active', useLogin);
    document.getElementById('tab-register')?.classList.toggle('active', !useLogin);
    document.getElementById('phase-2-login').style.display = useLogin ? 'block' : 'none';
    document.getElementById('phase-2-register').style.display = useLogin ? 'none' : 'block';

    const email = walletCheck?.user?.waltEmail || walletCheck?.user?.email || '';
    if (email) {
        document.getElementById('walt-login-email').value = email;
        document.getElementById('user-email').value = email;
    }

    const registerBtn = document.getElementById('btn-register-complete');
    if (registerBtn && isPendingOnChainRegistration()) {
        registerBtn.textContent = '✓ Potrdi v MetaMask';
    } else if (registerBtn) {
        registerBtn.textContent = '✓ Registracija';
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

function persistAuthSession() {
    sessionStorage.setItem('sessionId', currentSessionId);
    sessionStorage.setItem('user', JSON.stringify(currentUser));
}

function clearClientAuthSession() {
    sessionStorage.removeItem('sessionId');
    sessionStorage.removeItem('user');
    currentSessionId = null;
    currentUser = null;
}

function isMetaMaskRejectedError(error) {
    if (window.BlockchainMetaMask?.isMetaMaskUserRejection?.(error)) return true;
    const msg = String(error?.message || error || '');
    return msg === MM_REJECTED_MSG || /odobritvi transakcije v MetaMask/i.test(msg);
}

async function invalidateServerSession(sessionId) {
    if (!sessionId) return;
    try {
        await fetch('/api/auth/logout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId })
        });
    } catch (_) { /* */ }
}

async function refreshWalletCheck() {
    if (!currentWalletAddress) return;
    const checkResponse = await fetch(
        `/api/auth/check-wallet?walletAddress=${encodeURIComponent(currentWalletAddress)}`
    );
    if (!checkResponse.ok) {
        throw new Error('Napaka pri preverjanju denarnice');
    }
    walletCheck = await checkResponse.json();
}

async function finalizeAuthenticatedSession(authData, { errorElementId = 'login-error' } = {}) {
    const pendingSessionId = authData.sessionId;
    currentSessionId = pendingSessionId;
    currentUser = authData.user;

    try {
        if (authData.needsOnChainRegistration) {
            if (!window.BlockchainMetaMask) {
                throw new Error('Blockchain modul ni naložen. Osvežite stran (Ctrl+F5).');
            }
            updateLoadingStatus('MetaMask — potrdite registerUser...');
            await BlockchainMetaMask.ensureOnChainUser(
                pendingSessionId,
                authData.onChainRegistration?.did || currentUser.did,
                authData.onChainRegistration?.role || currentUser.role,
                { required: true }
            );
        }

        persistAuthSession();
        showLoading(false);
        redirectToRoleDashboard();
    } catch (error) {
        clearClientAuthSession();
        await invalidateServerSession(pendingSessionId);
        throw error;
    }
}

async function handleAuthFlowFailure(error, errorElementId) {
    showLoading(false);
    clearClientAuthSession();

    if (isMetaMaskRejectedError(error)) {
        showError(errorElementId, MM_REJECTED_MSG);
        if (errorElementId === 'registration-error') {
            setAuthMode('register');
            try {
                await refreshWalletCheck();
            } catch (_) { /* */ }
            if (currentWalletAddress) showAuthForm({ forceRegister: true });
        } else {
            setAuthMode('login');
            if (currentWalletAddress) showAuthForm({ forceLogin: true });
        }
        return;
    }

    showError(errorElementId, String(error?.message || error || 'Napaka pri avtentikaciji'));
    if (currentWalletAddress) {
        try {
            await refreshWalletCheck();
        } catch (_) { /* */ }
        if (errorElementId === 'registration-error') {
            showAuthForm({ forceRegister: true });
        } else {
            showAuthForm({ forceLogin: true });
        }
    }
}

async function connectMetaMask() {
    try {
        clearError('metamask-error');
        clearError('registration-error');
        clearError('login-error');
        if (!window.ethereum) {
            showError('metamask-error', 'MetaMask ni nameščen.');
            return;
        }
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        currentWalletAddress = accounts[0];
        document.getElementById('wallet-preview').innerHTML =
            `<div class="wallet-info"><p class="label">Denarnica</p><p class="address">${currentWalletAddress}</p></div>`;

        await refreshWalletCheck();
        if (!walletCheck) throw new Error('Napaka pri preverjanju denarnice');

        if (isPendingOnChainRegistration()) {
            setAuthMode('register');
            showError(
                'registration-error',
                'Registracija še ni dokončana. Vpišite geslo in v MetaMask odobrite transakcijo registerUser.'
            );
        } else if (walletCheck.registered && walletCheck.hasWaltId) {
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
        if (isMetaMaskRejectedError(e)) {
            showError('metamask-error', MM_REJECTED_MSG);
            return;
        }
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

        await finalizeAuthenticatedSession(data, { errorElementId: 'login-error' });
    } catch (e) {
        await handleAuthFlowFailure(e, 'login-error');
    }
}

async function completeOnChainAfterPartialRegistration(email, password) {
    showLoading(true, 'Potrditev v MetaMask...');
    const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: currentWalletAddress, waltEmail: email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    await finalizeAuthenticatedSession(data, { errorElementId: 'registration-error' });
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
        if (!email || !password) return showError('registration-error', 'Vpišite email in geslo.');

        if (isPendingOnChainRegistration()) {
            if (password.length < 8) return showError('registration-error', 'Geslo: min. 8 znakov.');
            await completeOnChainAfterPartialRegistration(email, password);
            return;
        }

        if (!role || !companyName) return showError('registration-error', 'Izpolnite vsa polja.');
        if (password.length < 8) return showError('registration-error', 'Geslo: min. 8 znakov.');
        if (password !== passwordConfirm) return showError('registration-error', 'Gesli se ne ujemata.');
        if (walletCheck?.registered && walletCheck?.hasWaltId) {
            return showError('registration-error', 'Račun že obstaja — uporabite Prijava.');
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

        updateLoadingStatus('Walt.id...');
        const waltRes = await fetch('/api/auth/register-walt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: mmData.sessionId, waltEmail: email, password })
        });
        const waltData = await waltRes.json();
        if (!waltRes.ok) throw new Error(waltData.error);

        if (waltData.did?.startsWith('did:key:')) {
            updateLoadingStatus(`did:key ustvarjen — ${waltData.did.slice(0, 28)}…`);
        } else if (waltData.did) {
            updateLoadingStatus(`Identiteta: ${waltData.did.slice(0, 28)}…`);
        }

        await finalizeAuthenticatedSession({
            sessionId: mmData.sessionId,
            user: waltData.user,
            needsOnChainRegistration: waltData.needsOnChainRegistration,
            onChainRegistration: waltData.onChainRegistration
        }, { errorElementId: 'registration-error' });
    } catch (e) {
        await handleAuthFlowFailure(e, 'registration-error');
    }
}

async function getUserInfo(sessionId) {
    const r = await fetch(`/api/auth/user-info?sessionId=${encodeURIComponent(sessionId)}`);
    if (!r.ok) throw new Error('user-info');
    return r.json();
}

async function logout() {
    try {
        const sessionId = currentSessionId || sessionStorage.getItem('sessionId');
        if (sessionId) {
            await invalidateServerSession(sessionId);
        }
        await disconnectMetaMask?.();
    } finally {
        sessionStorage.clear();
        currentSessionId = null;
        currentUser = null;
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
