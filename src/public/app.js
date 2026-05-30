/**
 * app.js
 * MetaMask login/registration with direct redirect to role dashboard
 */

let currentUser = null;
let currentSessionId = null;
let currentWalletAddress = null;
let isExistingUser = false;

document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

async function initializeApp() {
    console.log('🚀 Initializing application...');

    const sessionId = sessionStorage.getItem('sessionId');
    if (sessionId) {
        try {
            const validateResponse = await fetch(`/api/auth/validate-session?sessionId=${encodeURIComponent(sessionId)}`);
            if (!validateResponse.ok || !(await validateResponse.json()).valid) {
                sessionStorage.clear();
                showRegistration();
                attachEventListeners();
                return;
            }

            const userInfo = await getUserInfo(sessionId);
            if (userInfo.user) {
                currentUser = userInfo.user;
                currentSessionId = sessionId;
                sessionStorage.setItem('user', JSON.stringify(currentUser));
                redirectToRoleDashboard();
                return;
            }
            sessionStorage.clear();
        } catch (error) {
            console.log('No active session:', error.message);
            sessionStorage.clear();
        }
    }

    showRegistration();
    attachEventListeners();
}

function attachEventListeners() {
    document.getElementById('btn-connect-metamask').addEventListener('click', connectMetaMask);
    document.getElementById('btn-register-complete').addEventListener('click', completeRegistration);
    document.getElementById('btn-login').addEventListener('click', loginExistingUser);

    const confirmPasswordInput = document.getElementById('password-confirm');
    if (confirmPasswordInput) {
        confirmPasswordInput.addEventListener('input', validatePasswordsMatch);
    }

    document.getElementById('btn-logout').addEventListener('click', logout);
}

function showRegistration() {
    document.getElementById('progress-container').style.display = 'block';
    document.getElementById('section-registration').style.display = 'block';
    document.getElementById('section-registration').classList.add('active');
    document.getElementById('btn-logout').style.display = 'none';
    showPhase(1);
}

function showPhase(phaseNum) {
    document.getElementById('phase-1').style.display = phaseNum === 1 ? 'block' : 'none';
    document.getElementById('phase-2-register').style.display = phaseNum === 2 ? 'block' : 'none';
    document.getElementById('phase-2-login').style.display = phaseNum === 3 ? 'block' : 'none';

    document.getElementById('step-1').classList.toggle('active', phaseNum >= 1);
    document.getElementById('step-1').classList.toggle('completed', phaseNum > 1);
    document.getElementById('step-2').classList.toggle('active', phaseNum >= 2);
    document.getElementById('step-2').classList.toggle('completed', phaseNum > 2);
}

function getDashboardUrl(role) {
    const urls = {
        manufacturer: '/manufacturer-dashboard.html',
        distributor: '/distributor-dashboard.html',
        pharmacy: '/pharmacy-dashboard.html'
    };
    return urls[role] || '/';
}

function redirectToRoleDashboard() {
    if (!currentUser?.role) return;
    window.location.href = getDashboardUrl(currentUser.role);
}

async function persistSession() {
    sessionStorage.setItem('sessionId', currentSessionId);
    sessionStorage.setItem('user', JSON.stringify(currentUser));
}

async function refreshCurrentUser() {
    const userInfo = await getUserInfo(currentSessionId);
    if (userInfo.user) {
        currentUser = userInfo.user;
        await persistSession();
    }
}

async function connectMetaMask() {
    try {
        clearError('metamask-error');

        if (!window.ethereum) {
            showError('metamask-error', 'MetaMask ni inštaliran. Prosimo namestite MetaMask razširitev.');
            return;
        }

        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        const connectedAddress = accounts[0];
        currentWalletAddress = connectedAddress;

        const walletPreview = document.getElementById('wallet-preview');
        walletPreview.innerHTML = `
            <div class="wallet-info">
                <p class="label">Povezana Denarnica:</p>
                <p class="address">${connectedAddress}</p>
            </div>
        `;

        const checkResponse = await fetch(
            `/api/auth/check-wallet?walletAddress=${encodeURIComponent(connectedAddress)}`
        );
        if (!checkResponse.ok) {
            throw new Error('Napaka pri preverjanju denarnice');
        }

        const checkData = await checkResponse.json();

        if (checkData.registered && checkData.hasWaltId) {
            isExistingUser = true;
            showPhase(3);
            clearError('login-error');
            return;
        }

        isExistingUser = false;
        showPhase(2);

        if (checkData.registered && checkData.user) {
            document.getElementById('role-select').value = checkData.user.role || '';
            document.getElementById('company-name').value = checkData.user.companyName || '';
            document.getElementById('company-email').value = checkData.user.email || '';
        }

        clearError('registration-error');
    } catch (error) {
        console.error('MetaMask connection error:', error);
        showError('metamask-error', error.message || 'Napaka pri povezovanju MetaMaska');
    }
}

async function loginExistingUser() {
    try {
        clearError('login-error');

        if (!currentWalletAddress) {
            showError('login-error', 'Najprej povežite MetaMask denarnico.');
            return;
        }

        showLoading(true, 'Prijavljam...');

        const loginResponse = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ walletAddress: currentWalletAddress })
        });

        if (!loginResponse.ok) {
            const errorData = await loginResponse.json();
            throw new Error(errorData.error || 'Napaka pri prijavi');
        }

        const loginData = await loginResponse.json();
        currentSessionId = loginData.sessionId;
        currentUser = loginData.user;
        await refreshCurrentUser();
        await persistSession();

        showLoading(false);
        redirectToRoleDashboard();
    } catch (error) {
        showLoading(false);
        showError('login-error', error.message);
    }
}

function validatePasswordStrength(password) {
    return password.length >= 8;
}

function validatePasswordsMatch() {
    const password = document.getElementById('password').value;
    const confirm = document.getElementById('password-confirm').value;
    const error = document.getElementById('password-match-error');

    if (confirm && password !== confirm) {
        error.style.display = 'block';
        return false;
    }
    error.style.display = 'none';
    return true;
}

async function completeRegistration() {
    try {
        clearError('registration-error');

        const role = document.getElementById('role-select').value;
        const companyName = document.getElementById('company-name').value;
        const email = document.getElementById('company-email').value;
        const password = document.getElementById('password').value;
        const passwordConfirm = document.getElementById('password-confirm').value;

        if (!currentWalletAddress) {
            showError('registration-error', 'Napaka: Denarnica ni povezana. Prosimo ponovno povežite MetaMask.');
            return;
        }

        if (!role || !companyName || !email || !password || !passwordConfirm) {
            showError('registration-error', 'Prosimo izpolnite vsa polja');
            return;
        }

        if (!validatePasswordStrength(password)) {
            showError('registration-error', 'Geslo mora imeti najmanj 8 znakov');
            return;
        }

        if (!validatePasswordsMatch()) {
            showError('registration-error', 'Gesli se ne ujemata');
            return;
        }

        showLoading(true, 'Povezujem denarnico...');

        const metamaskResponse = await fetch('/api/auth/connect-metamask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                walletAddress: currentWalletAddress,
                role,
                companyName,
                email
            })
        });

        const metamaskData = await metamaskResponse.json();

        if (!metamaskResponse.ok) {
            throw new Error(metamaskData.error || 'Napaka pri povezovanju MetaMaska');
        }

        if (metamaskData.alreadyRegistered && metamaskData.user?.did) {
            const loginResponse = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ walletAddress: currentWalletAddress })
            });
            const loginData = await loginResponse.json();
            if (!loginResponse.ok) {
                throw new Error(loginData.error || 'Napaka pri prijavi');
            }
            currentSessionId = loginData.sessionId;
            currentUser = loginData.user;
            await refreshCurrentUser();
            await persistSession();
            showLoading(false);
            redirectToRoleDashboard();
            return;
        }

        currentSessionId = metamaskData.sessionId;
        currentUser = metamaskData.user;

        updateLoadingStatus('Registracija v Walt.id...');

        const waltResponse = await fetch('/api/auth/register-walt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: currentSessionId,
                password
            })
        });

        const waltData = await waltResponse.json();
        if (!waltResponse.ok) {
            throw new Error(waltData.error || 'Napaka pri registraciji v Walt.id');
        }

        currentUser = waltData.user;
        await refreshCurrentUser();
        await persistSession();

        updateLoadingStatus('Pripravljeno! ✓');
        await new Promise(resolve => setTimeout(resolve, 400));
        showLoading(false);
        redirectToRoleDashboard();
    } catch (error) {
        console.error('Registration error:', error);
        showLoading(false);
        showError('registration-error', error.message);
    }
}

async function getUserInfo(sessionId) {
    const response = await fetch(`/api/auth/user-info?sessionId=${encodeURIComponent(sessionId)}`);
    if (!response.ok) {
        throw new Error('Failed to get user info');
    }
    return await response.json();
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
        await disconnectMetaMask();
    } catch (error) {
        console.error('Logout error:', error);
    } finally {
        sessionStorage.clear();
        currentUser = null;
        currentSessionId = null;
        currentWalletAddress = null;
        isExistingUser = false;

        document.getElementById('role-select').value = '';
        document.getElementById('company-name').value = '';
        document.getElementById('company-email').value = '';
        document.getElementById('password').value = '';
        document.getElementById('password-confirm').value = '';
        document.getElementById('wallet-preview').innerHTML = '';

        showRegistration();
    }
}

function getRoleLabel(role) {
    const labels = {
        manufacturer: '🏭 Proizvajalec',
        distributor: '📦 Distributor',
        pharmacy: '💊 Lekarna'
    };
    return labels[role] || role;
}

function showError(elementId, message) {
    const element = document.getElementById(elementId);
    element.textContent = message;
    element.style.display = 'block';
}

function clearError(elementId) {
    const element = document.getElementById(elementId);
    element.textContent = '';
    element.style.display = 'none';
}

function showLoading(show, initialStatus = 'Prosimo počakajte...') {
    const loadingDiv = document.getElementById('registration-loading');
    const statusText = document.getElementById('loading-status');
    const registerBtn = document.getElementById('btn-register-complete');
    const loginBtn = document.getElementById('btn-login');

    if (show) {
        statusText.textContent = initialStatus;
        loadingDiv.style.display = 'block';
        if (registerBtn) registerBtn.disabled = true;
        if (loginBtn) loginBtn.disabled = true;
    } else {
        loadingDiv.style.display = 'none';
        if (registerBtn) registerBtn.disabled = false;
        if (loginBtn) loginBtn.disabled = false;
    }
}

function updateLoadingStatus(status) {
    document.getElementById('loading-status').textContent = status;
}

if (window.ethereum) {
    window.ethereum.on('accountsChanged', (accounts) => {
        if (accounts.length === 0) {
            logout();
        } else if (currentUser && accounts[0].toLowerCase() !== currentUser.walletAddress?.toLowerCase()) {
            logout();
        }
    });
}
