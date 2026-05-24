/**
 * app.js
 * Main application logic for MetaMask connection and Walt.id registration
 * Simplified onboarding with auto-chaining flow
 */

// ===== STATE MANAGEMENT =====
let currentUser = null;
let currentSessionId = null;
let currentWalletAddress = null;

// ===== INITIALIZATION =====
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

async function initializeApp() {
    console.log('🚀 Initializing application...');
    
    // Check if user already has active session
    const sessionId = sessionStorage.getItem('sessionId');
    if (sessionId) {
        try {
            const userInfo = await getUserInfo(sessionId);
            if (userInfo.user) {
                currentUser = userInfo.user;
                currentSessionId = sessionId;
                showDashboardSelection();
            }
        } catch (error) {
            console.log('No active session or session expired');
            showRegistration();
        }
    } else {
        showRegistration();
    }
    
    attachEventListeners();
}

function attachEventListeners() {
    // MetaMask Connection
    document.getElementById('btn-connect-metamask').addEventListener('click', connectMetaMask);
    
    // Complete Registration (combines MetaMask + Walt.id)
    document.getElementById('btn-register-complete').addEventListener('click', completeRegistration);
    
    // Password validation listeners
    const passwordInput = document.getElementById('password');
    const confirmPasswordInput = document.getElementById('password-confirm');
    
    if (passwordInput) {
        passwordInput.addEventListener('input', updatePasswordStrength);
    }
    
    if (confirmPasswordInput) {
        confirmPasswordInput.addEventListener('input', validatePasswordsMatch);
    }
    
    // Dashboard Selection
    document.getElementById('btn-manufacturer-dashboard').addEventListener('click', () => {
        window.location.href = '/manufacturer-dashboard.html';
    });
    document.getElementById('btn-distributor-dashboard').addEventListener('click', () => {
        window.location.href = '/distributor-dashboard.html';
    });
    document.getElementById('btn-pharmacy-dashboard').addEventListener('click', () => {
        window.location.href = '/pharmacy-dashboard.html';
    });
    
    // Logout
    document.getElementById('btn-logout').addEventListener('click', logout);
}

// ===== UI STATE CHANGES =====
function showRegistration() {
    document.getElementById('progress-container').style.display = 'block';
    document.getElementById('section-registration').style.display = 'block';
    document.getElementById('section-registration').classList.add('active');
    document.getElementById('section-dashboard').style.display = 'none';
    document.getElementById('btn-logout').style.display = 'none';
    
    // Show Phase 1 (MetaMask)
    showPhase(1);
}

function showPhase(phaseNum) {
    document.getElementById('phase-1').style.display = phaseNum === 1 ? 'block' : 'none';
    document.getElementById('phase-2').style.display = phaseNum === 2 ? 'block' : 'none';
    
    // Update progress indicator
    document.getElementById('step-1').classList.toggle('active', phaseNum >= 1);
    document.getElementById('step-1').classList.toggle('completed', phaseNum > 1);
    document.getElementById('step-2').classList.toggle('active', phaseNum === 2);
    
    if (phaseNum === 1) {
        document.getElementById('step-1').classList.add('active');
        document.getElementById('step-2').classList.remove('active', 'completed');
    } else if (phaseNum === 2) {
        document.getElementById('step-1').classList.add('completed');
        document.getElementById('step-2').classList.add('active');
    }
}

function showDashboardSelection() {
    document.getElementById('progress-container').style.display = 'none';
    document.getElementById('section-registration').style.display = 'none';
    document.getElementById('section-dashboard').style.display = 'block';
    document.getElementById('section-dashboard').classList.add('active');
    document.getElementById('btn-logout').style.display = 'inline-block';
    
    // Update progress indicator - all done
    document.getElementById('step-1').classList.add('completed');
    document.getElementById('step-2').classList.add('completed');
    document.getElementById('step-3').classList.add('active', 'completed');
    
    // Display user info
    const dashboardInfo = document.getElementById('dashboard-info');
    dashboardInfo.innerHTML = `
        <div class="profile-info">
            <div class="profile-info-item">
                <div class="profile-info-label">Naslov Denarnice</div>
                <div class="profile-info-value">${currentUser.walletAddress}</div>
            </div>
            <div class="profile-info-item">
                <div class="profile-info-label">Vloga</div>
                <div class="profile-info-value">${getRoleLabel(currentUser.role)}</div>
            </div>
            <div class="profile-info-item">
                <div class="profile-info-label">Ime Podjetja</div>
                <div class="profile-info-value">${currentUser.companyName}</div>
            </div>
        </div>
    `;
    
    // Show only the appropriate dashboard button
    document.getElementById('btn-manufacturer-dashboard').style.display = 
        currentUser.role === 'manufacturer' ? 'flex' : 'none';
    document.getElementById('btn-distributor-dashboard').style.display = 
        currentUser.role === 'distributor' ? 'flex' : 'none';
    document.getElementById('btn-pharmacy-dashboard').style.display = 
        currentUser.role === 'pharmacy' ? 'flex' : 'none';
    
    updateWalletStatus();
}

function updateWalletStatus() {
    if (currentUser) {
        const shortAddress = currentUser.walletAddress.substring(0, 6) + '...' + currentUser.walletAddress.substring(-4);
        document.getElementById('wallet-status').textContent = 
            `✓ Wallet: ${shortAddress} | ${getRoleLabel(currentUser.role)}`;
    }
}

// ===== API CALLS =====
async function connectMetaMask() {
    try {
        clearError('metamask-error');
        
        // Check for MetaMask
        if (!window.ethereum) {
            showError('metamask-error', 'MetaMask ni inštaliran. Prosimo namestite MetaMask razširitev.');
            return;
        }
        
        // Request MetaMask connection
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        const connectedAddress = accounts[0];
        
        console.log('✓ MetaMask connected:', connectedAddress);
        
        // Store wallet address for later use
        currentWalletAddress = connectedAddress;
        
        // Display wallet preview and move to Phase 2
        const walletPreview = document.getElementById('wallet-preview');
        walletPreview.innerHTML = `
            <div class="wallet-info">
                <p class="label">Povezana Denarnica:</p>
                <p class="address">${connectedAddress}</p>
            </div>
        `;
        
        // Show Phase 2
        showPhase(2);
        clearError('registration-error');
        
    } catch (error) {
        console.error('MetaMask connection error:', error);
        showError('metamask-error', error.message || 'Napaka pri povezovanju MetaMaska');
    }
}

// ===== PASSWORD VALIDATION FUNCTIONS =====
function validatePasswordStrength(password) {
    let strength = 0;
    const requirements = {
        length: password.length >= 8,
        upper: /[A-Z]/.test(password),
        lower: /[a-z]/.test(password),
        number: /[0-9]/.test(password),
        special: /[!@#$%^&*]/.test(password)
    };

    // Update visual requirements
    updateRequirement('req-length', requirements.length);
    updateRequirement('req-upper', requirements.upper);
    updateRequirement('req-lower', requirements.lower);
    updateRequirement('req-number', requirements.number);
    updateRequirement('req-special', requirements.special);

    // Calculate strength
    for (let key in requirements) {
        if (requirements[key]) strength++;
    }

    return { strength, requirements, allMet: strength === 5 };
}

function updateRequirement(id, met) {
    const element = document.getElementById(id);
    if (element) {
        if (met) {
            element.classList.add('met');
        } else {
            element.classList.remove('met');
        }
    }
}

function updatePasswordStrength() {
    const password = document.getElementById('password').value;
    const { strength, allMet } = validatePasswordStrength(password);
    
    const strengthBar = document.querySelector('.strength-bar');
    const strengthText = document.querySelector('.strength-text');
    
    if (password.length === 0) {
        strengthBar.className = 'strength-bar';
        strengthText.className = 'strength-text';
        strengthText.textContent = '';
        return;
    }

    const strengthLevels = ['weak', 'weak', 'fair', 'good', 'strong', 'strong'];
    const strengthLabels = ['Šibko', 'Šibko', 'Dovolj', 'Dobro', 'Zelo Dobro', 'Zelo Dobro'];
    
    const level = strengthLevels[strength];
    const label = strengthLabels[strength];
    
    strengthBar.className = `strength-bar ${level}`;
    strengthText.className = `strength-text ${level}`;
    strengthText.textContent = label;
}

function validatePasswordsMatch() {
    const password = document.getElementById('password').value;
    const confirm = document.getElementById('password-confirm').value;
    const error = document.getElementById('password-match-error');
    
    if (confirm && password !== confirm) {
        error.style.display = 'block';
        return false;
    } else {
        error.style.display = 'none';
        return true;
    }
}

/**
 * Complete Registration - Chains MetaMask connection with Walt.id registration
 * Automatically calls both endpoints without requiring separate user action
 */
async function completeRegistration() {
    try {
        clearError('registration-error');
        
        // Validate inputs
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

        // Validate password strength
        const { allMet } = validatePasswordStrength(password);
        if (!allMet) {
            showError('registration-error', 'Geslo ne izpolnjuje vseh zahtev');
            return;
        }

        // Validate password match
        if (!validatePasswordsMatch()) {
            showError('registration-error', 'Gesli se ne ujemata');
            return;
        }
        
        // Show loading state
        showLoading(true, 'Povezujem denarnico...');
        
        // Step 1: Connect MetaMask on backend
        console.log('📝 Step 1: Registering MetaMask connection on backend...');
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
        
        if (!metamaskResponse.ok) {
            const errorData = await metamaskResponse.json();
            throw new Error(errorData.error || 'Napaka pri povezovanju MetaMaska');
        }
        
        const metamaskData = await metamaskResponse.json();
        
        if (!metamaskData.success) {
            throw new Error(metamaskData.error || 'Napaka pri povezovanju MetaMaska');
        }
        
        currentSessionId = metamaskData.sessionId;
        currentUser = metamaskData.user;
        
        // Step 2: Register in Walt.id with password
        console.log('📝 Step 2: Registering in Walt.id...');
        updateLoadingStatus('Registracija v Walt.id...');
        
        const waltResponse = await fetch('/api/auth/register-walt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: currentSessionId,
                password: password
            })
        });
        
        if (!waltResponse.ok) {
            const errorData = await waltResponse.json();
            throw new Error(errorData.error || 'Napaka pri registraciji v Walt.id');
        }
        
        const waltData = await waltResponse.json();
        
        if (!waltData.success) {
            throw new Error(waltData.error || 'Napaka pri registraciji v Walt.id');
        }
        
        // Update user with DID and wallet ID
        currentUser = waltData.user;
        
        // Store session
        sessionStorage.setItem('sessionId', currentSessionId);
        sessionStorage.setItem('user', JSON.stringify(currentUser));
        
        console.log('✓ Complete registration successful:', currentUser);
        
        // Hide loading and show success
        updateLoadingStatus('Pripravljeno! ✓');
        await new Promise(resolve => setTimeout(resolve, 500));
        
        showLoading(false);
        showDashboardSelection();
        
    } catch (error) {
        console.error('Registration error:', error);
        showLoading(false);
        showError('registration-error', error.message);
    }
}

async function getUserInfo(sessionId) {
    const response = await fetch(`/api/auth/user-info?sessionId=${sessionId}`);
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
        
        // Clear session
        sessionStorage.removeItem('sessionId');
        sessionStorage.removeItem('user');
        currentUser = null;
        currentSessionId = null;
        currentWalletAddress = null;
        
        // Reset form
        document.getElementById('role-select').value = '';
        document.getElementById('company-name').value = '';
        document.getElementById('company-email').value = '';
        document.getElementById('wallet-preview').innerHTML = '';
        
        // Show registration
        showRegistration();
    } catch (error) {
        console.error('Logout error:', error);
    }
}

// ===== HELPER FUNCTIONS =====
function getRoleLabel(role) {
    const labels = {
        'manufacturer': '🏭 Proizvajalec',
        'distributor': '📦 Distributor',
        'pharmacy': '💊 Lekarna'
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

function showLoading(show, initialStatus = 'Registracija v teku...') {
    const loadingDiv = document.getElementById('registration-loading');
    const statusText = document.getElementById('loading-status');
    
    if (show) {
        statusText.textContent = initialStatus;
        loadingDiv.style.display = 'block';
        document.getElementById('btn-register-complete').disabled = true;
    } else {
        loadingDiv.style.display = 'none';
        document.getElementById('btn-register-complete').disabled = false;
        statusText.textContent = 'Registracija v teku...';
    }
}

function updateLoadingStatus(status) {
    document.getElementById('loading-status').textContent = status;
}

// ===== METAMASK LISTENER =====
if (window.ethereum) {
    window.ethereum.on('accountsChanged', (accounts) => {
        if (accounts.length === 0) {
            // User disconnected MetaMask
            logout();
        } else if (currentUser && accounts[0] !== currentUser.walletAddress) {
            // User switched accounts - logout and prompt to reconnect
            logout();
        }
    });
}
