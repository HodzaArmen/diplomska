/**
 * dashboard-manufacturer.js
 * Manufacturer dashboard functionality
 */

let currentUser = null;
let currentSessionId = null;
let issuedMedicines = [];

document.addEventListener('DOMContentLoaded', () => {
    initializeDashboard();
});

async function initializeDashboard() {
    try {
        // Get session from storage
        currentSessionId = sessionStorage.getItem('sessionId');
        const userJson = sessionStorage.getItem('user');
        
        if (!currentSessionId || !userJson) {
            window.location.href = '/';
            return;
        }
        
        // Validate session with backend
        try {
            const validateResponse = await fetch(`/api/auth/validate-session?sessionId=${encodeURIComponent(currentSessionId)}`);
            if (!validateResponse.ok || !(await validateResponse.json()).valid) {
                // Session is invalid or expired - clear it and redirect
                sessionStorage.clear();
                window.location.href = '/';
                return;
            }
        } catch (error) {
            console.error('Session validation error:', error);
            sessionStorage.clear();
            window.location.href = '/';
            return;
        }
        
        currentUser = JSON.parse(userJson);
        
        // Check if user is manufacturer
        if (currentUser.role !== 'manufacturer') {
            alert('Dostop zavrnjen: Ta nadzorna plošča je samo za proizvajalce.');
            window.location.href = '/';
            return;
        }
        
        displayUserProfile();
        attachEventListeners();
        updateWalletStatus();
        loadIssuedMedicines();
    } catch (error) {
        console.error('Initialization error:', error);
        alert('Napaka pri inicijalizaciji nadzorne plošče');
        sessionStorage.clear();
        window.location.href = '/';
    }
}

function displayUserProfile() {
    const profileDiv = document.getElementById('manufacturer-profile');
    profileDiv.innerHTML = `
        <div class="profile-info-item">
            <div class="profile-info-label">Naslov Denarnice</div>
            <div class="profile-info-value">${currentUser.walletAddress}</div>
        </div>
        <div class="profile-info-item">
            <div class="profile-info-label">Ime Podjetja</div>
            <div class="profile-info-value">${currentUser.companyName}</div>
        </div>
        <div class="profile-info-item">
            <div class="profile-info-label">Email</div>
            <div class="profile-info-value">${currentUser.email}</div>
        </div>
        <div class="profile-info-item">
            <div class="profile-info-label">DID</div>
            <div class="profile-info-value" title="${currentUser.did || 'N/A'}">${(currentUser.did || 'N/A').substring(0, 20)}...</div>
        </div>
    `;
}

function updateWalletStatus() {
    const shortAddress = currentUser.walletAddress.substring(0, 6) + '...' + currentUser.walletAddress.substring(-4);
    document.getElementById('wallet-status').textContent = `✓ Wallet: ${shortAddress}`;
}

function attachEventListeners() {
    // Back to home
    document.getElementById('btn-back-home').addEventListener('click', async () => {
        try {
            if (currentSessionId) {
                await fetch('/api/auth/logout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: currentSessionId })
                });
            }
        } catch (error) {
            console.error('Logout error:', error);
        } finally {
            sessionStorage.clear();
            window.location.href = '/';
        }
    });
    
    // Issue credential
    document.getElementById('btn-issue-credential').addEventListener('click', issueCredential);
    
    // Register medicine
    document.getElementById('btn-register-medicine').addEventListener('click', registerMedicine);
}

async function issueCredential() {
    try {
        clearMessages();
        
        const medicineName = document.getElementById('medicine-name').value;
        const batchNumber = document.getElementById('batch-number').value;
        const expiryDate = document.getElementById('expiry-date').value;
        const quantity = document.getElementById('quantity').value;
        
        if (!medicineName || !batchNumber || !expiryDate || !quantity) {
            showError('issue-error', 'Prosimo izpolnite vsa polja');
            return;
        }
        
        const btn = document.getElementById('btn-issue-credential');
        btn.disabled = true;
        btn.textContent = 'Izdajam...';
        
        // In a real implementation, this would call the Walt.id Issuer API
        // For now, we'll simulate the issuance
        const medicineRecord = {
            id: `MED-${Date.now()}`,
            medicineName,
            batchNumber,
            expiryDate,
            quantity,
            manufacturer: currentUser.companyName,
            issuedAt: new Date().toISOString(),
            did: currentUser.did
        };
        
        issuedMedicines.push(medicineRecord);
        localStorage.setItem('issued_medicines', JSON.stringify(issuedMedicines));
        
        showSuccess('issue-success', '✓ Poverilnica je bila uspešno izdana!');
        
        // Clear form
        document.getElementById('medicine-name').value = '';
        document.getElementById('batch-number').value = '';
        document.getElementById('expiry-date').value = '';
        document.getElementById('quantity').value = '';
        
        // Reload medicines list
        loadIssuedMedicines();
    } catch (error) {
        console.error('Error issuing credential:', error);
        showError('issue-error', 'Napaka: ' + error.message);
    } finally {
        const btn = document.getElementById('btn-issue-credential');
        btn.disabled = false;
        btn.textContent = 'Izdajte Poverilnico';
    }
}

async function registerMedicine() {
    try {
        clearMessages();
        
        const medicineId = document.getElementById('medicine-id').value;
        const ipfsHash = document.getElementById('ipfs-hash').value;
        
        if (!medicineId || !ipfsHash) {
            showError('blockchain-error', 'Prosimo izpolnite vsa polja');
            return;
        }
        
        const btn = document.getElementById('btn-register-medicine');
        btn.disabled = true;
        btn.textContent = 'Registriram...';
        
        // In a real implementation, this would call the Ethereum smart contract
        // For now, we'll simulate the registration
        console.log('Registering medicine on blockchain:', { medicineId, ipfsHash });
        
        showSuccess('blockchain-success', '✓ Zdravilo je bilo uspešno registrirano na blockchainu!');
        
        // Clear form
        document.getElementById('medicine-id').value = '';
        document.getElementById('ipfs-hash').value = '';
    } catch (error) {
        console.error('Error registering medicine:', error);
        showError('blockchain-error', 'Napaka: ' + error.message);
    } finally {
        const btn = document.getElementById('btn-register-medicine');
        btn.disabled = false;
        btn.textContent = 'Registrirajte Zdravilo';
    }
}

function loadIssuedMedicines() {
    const stored = localStorage.getItem('issued_medicines');
    if (stored) {
        issuedMedicines = JSON.parse(stored);
    }
    
    const listDiv = document.getElementById('medicines-list');
    
    if (issuedMedicines.length === 0) {
        listDiv.innerHTML = '<p class="text-muted">Ni še izdanih poverilnic...</p>';
        return;
    }
    
    const html = `
        <table>
            <thead>
                <tr>
                    <th>ID</th>
                    <th>Zdravilo</th>
                    <th>Serijska Številka</th>
                    <th>Rok Trajanja</th>
                    <th>Količina</th>
                    <th>Izdano</th>
                </tr>
            </thead>
            <tbody>
                ${issuedMedicines.map(m => `
                    <tr>
                        <td>${m.id}</td>
                        <td>${m.medicineName}</td>
                        <td>${m.batchNumber}</td>
                        <td>${m.expiryDate}</td>
                        <td>${m.quantity}</td>
                        <td>${new Date(m.issuedAt).toLocaleDateString('sl-SI')}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
    
    listDiv.innerHTML = html;
}

function clearMessages() {
    document.getElementById('issue-error').style.display = 'none';
    document.getElementById('issue-success').style.display = 'none';
    document.getElementById('blockchain-error').style.display = 'none';
    document.getElementById('blockchain-success').style.display = 'none';
}

function showError(elementId, message) {
    const element = document.getElementById(elementId);
    element.textContent = message;
    element.style.display = 'block';
}

function showSuccess(elementId, message) {
    const element = document.getElementById(elementId);
    element.textContent = message;
    element.style.display = 'block';
}
