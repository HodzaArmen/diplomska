/**
 * app.js
 * Main application logic for MetaMask connection and Walt.id registration
 */

// ===== STATE MANAGEMENT =====
let currentUser = null;
let currentSessionId = null;

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
            showMetaMaskConnection();
        }
    } else {
        showMetaMaskConnection();
    }
    
    attachEventListeners();
}

function attachEventListeners() {
    // MetaMask Connection
    document.getElementById('btn-connect-metamask').addEventListener('click', connectMetaMask);
    
    // Walt.id Registration
    document.getElementById('btn-register-walt').addEventListener('click', registerInWalt);
    
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
function showMetaMaskConnection() {
    document.getElementById('section-metamask').classList.add('active');
    document.getElementById('section-walt').style.display = 'none';
    document.getElementById('section-dashboard').style.display = 'none';
    document.getElementById('btn-logout').style.display = 'none';
}

function showWaltRegistration() {
    document.getElementById('section-metamask').classList.remove('active');
    document.getElementById('section-metamask').style.display = 'none';
    document.getElementById('section-walt').style.display = 'block';
    document.getElementById('section-walt').classList.add('active');
    document.getElementById('btn-logout').style.display = 'inline-block';
    
    // Display user info
    const userInfoDiv = document.getElementById('user-info');
    userInfoDiv.innerHTML = `
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
            <div class="profile-info-item">
                <div class="profile-info-label">Email</div>
                <div class="profile-info-value">${currentUser.email}</div>
            </div>
        </div>
    `;
}

function showDashboardSelection() {
    document.getElementById('section-metamask').style.display = 'none';
    document.getElementById('section-walt').style.display = 'none';
    document.getElementById('section-dashboard').style.display = 'block';
    document.getElementById('section-dashboard').classList.add('active');
    document.getElementById('btn-logout').style.display = 'inline-block';
    
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
        
        // Validate inputs
        const walletAddress = document.getElementById('wallet-address')?.value;
        const role = document.getElementById('role-select').value;
        const companyName = document.getElementById('company-name').value;
        const email = document.getElementById('company-email').value;
        
        if (!role || !companyName || !email) {
            showError('metamask-error', 'Prosimo izpolnite vsa polja');
            return;
        }
        
        // Check for MetaMask
        if (!window.ethereum) {
            showError('metamask-error', 'MetaMask ni inštaliran. Prosimo namestite MetaMask razširitev.');
            return;
        }
        
        // Request MetaMask connection
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        const connectedAddress = accounts[0];
        
        // Call backend to register connection
        const response = await fetch('/api/auth/connect-metamask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                walletAddress: connectedAddress,
                role,
                companyName,
                email
            })
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Napaka pri povezovanju MetaMaska');
        }
        
        const data = await response.json();
        
        if (data.success) {
            currentSessionId = data.sessionId;
            currentUser = data.user;
            
            // Store session
            sessionStorage.setItem('sessionId', currentSessionId);
            sessionStorage.setItem('user', JSON.stringify(currentUser));
            
            console.log('✓ MetaMask connected:', currentUser);
            showWaltRegistration();
        }
    } catch (error) {
        console.error('MetaMask connection error:', error);
        showError('metamask-error', error.message);
    }
}

async function registerInWalt() {
    try {
        clearError('walt-error');
        
        if (!currentSessionId) {
            showError('walt-error', 'Napaka: Seja ni aktivna. Prosimo ponovno se povežite s MetaMaskom.');
            return;
        }
        
        // Disable button during request
        const btn = document.getElementById('btn-register-walt');
        btn.disabled = true;
        btn.textContent = 'Registriranje...';
        
        const response = await fetch('/api/auth/register-walt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: currentSessionId
            })
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Napaka pri registraciji v Walt.id');
        }
        
        const data = await response.json();
        
        if (data.success) {
            // Update user with DID and wallet ID
            currentUser = data.user;
            sessionStorage.setItem('user', JSON.stringify(currentUser));
            
            console.log('✓ Registered in Walt.id:', data.user);
            showDashboardSelection();
        }
    } catch (error) {
        console.error('Walt.id registration error:', error);
        showError('walt-error', error.message);
    } finally {
        const btn = document.getElementById('btn-register-walt');
        btn.disabled = false;
        btn.textContent = 'Registrirajte se v Walt.id';
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
        
        // Reset form
        document.getElementById('role-select').value = '';
        document.getElementById('company-name').value = '';
        document.getElementById('company-email').value = '';
        
        // Show MetaMask connection
        showMetaMaskConnection();
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
