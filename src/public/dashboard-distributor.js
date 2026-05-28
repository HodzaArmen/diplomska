/**
 * dashboard-distributor.js
 * Distributor dashboard functionality
 */

let currentUser = null;
let currentSessionId = null;
let inventory = [];
let shipments = [];

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
        
        // Check if user is distributor
        if (currentUser.role !== 'distributor') {
            alert('Dostop zavrnjen: Ta nadzorna plošča je samo za distributerje.');
            window.location.href = '/';
            return;
        }
        
        displayUserProfile();
        attachEventListeners();
        updateWalletStatus();
        loadInventory();
        loadShipments();
    } catch (error) {
        console.error('Initialization error:', error);
        alert('Napaka pri inicijalizaciji nadzorne plošče');
        sessionStorage.clear();
        window.location.href = '/';
    }
}

function displayUserProfile() {
    const profileDiv = document.getElementById('distributor-profile');
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
    
    // Receive medicine
    document.getElementById('btn-receive-medicine').addEventListener('click', receiveMedicine);
    
    // Update shipment
    document.getElementById('btn-update-shipment').addEventListener('click', updateShipment);
}

async function receiveMedicine() {
    try {
        clearMessages();
        
        const medicineId = document.getElementById('medicine-id-receive').value;
        const batch = document.getElementById('medicine-batch-receive').value;
        const quantity = document.getElementById('quantity-receive').value;
        
        if (!medicineId || !batch || !quantity) {
            showError('receive-error', 'Prosimo izpolnite vsa polja');
            return;
        }
        
        const btn = document.getElementById('btn-receive-medicine');
        btn.disabled = true;
        btn.textContent = 'Potvrjujem...';
        
        // Add to inventory
        const item = {
            id: medicineId,
            batch,
            quantity: parseInt(quantity),
            receivedAt: new Date().toISOString(),
            status: 'in_warehouse'
        };
        
        inventory.push(item);
        localStorage.setItem('distributor_inventory', JSON.stringify(inventory));
        
        showSuccess('receive-success', '✓ Zdravilo je bilo uspešno prevzeto!');
        
        // Clear form
        document.getElementById('medicine-id-receive').value = '';
        document.getElementById('medicine-batch-receive').value = '';
        document.getElementById('quantity-receive').value = '';
        
        // Reload inventory
        loadInventory();
    } catch (error) {
        console.error('Error receiving medicine:', error);
        showError('receive-error', 'Napaka: ' + error.message);
    } finally {
        const btn = document.getElementById('btn-receive-medicine');
        btn.disabled = false;
        btn.textContent = 'Potrdi Sprejem';
    }
}

async function updateShipment() {
    try {
        clearMessages();
        
        const shipmentId = document.getElementById('shipment-id').value;
        const status = document.getElementById('shipment-status').value;
        const location = document.getElementById('shipment-location').value;
        
        if (!shipmentId || !status || !location) {
            showError('shipment-error', 'Prosimo izpolnite vsa polja');
            return;
        }
        
        const btn = document.getElementById('btn-update-shipment');
        btn.disabled = true;
        btn.textContent = 'Posodabljam...';
        
        // Add shipment record
        const shipment = {
            id: shipmentId,
            status,
            location,
            updatedAt: new Date().toISOString()
        };
        
        // Check if shipment exists and update it, otherwise create new
        const existingIndex = shipments.findIndex(s => s.id === shipmentId);
        if (existingIndex >= 0) {
            shipments[existingIndex] = shipment;
        } else {
            shipments.push(shipment);
        }
        
        localStorage.setItem('distributor_shipments', JSON.stringify(shipments));
        
        showSuccess('shipment-success', '✓ Status pošiljke je bil uspešno posodobljen!');
        
        // Clear form
        document.getElementById('shipment-id').value = '';
        document.getElementById('shipment-status').value = '';
        document.getElementById('shipment-location').value = '';
        
        // Reload shipments
        loadShipments();
    } catch (error) {
        console.error('Error updating shipment:', error);
        showError('shipment-error', 'Napaka: ' + error.message);
    } finally {
        const btn = document.getElementById('btn-update-shipment');
        btn.disabled = false;
        btn.textContent = 'Posodobi Status';
    }
}

function loadInventory() {
    const stored = localStorage.getItem('distributor_inventory');
    if (stored) {
        inventory = JSON.parse(stored);
    }
    
    const listDiv = document.getElementById('inventory-list');
    
    if (inventory.length === 0) {
        listDiv.innerHTML = '<p class="text-muted">Ni še prevzetih zdravil...</p>';
        return;
    }
    
    const html = `
        <table>
            <thead>
                <tr>
                    <th>ID Zdravila</th>
                    <th>Serijska Številka</th>
                    <th>Količina</th>
                    <th>Status</th>
                    <th>Prevzeto</th>
                </tr>
            </thead>
            <tbody>
                ${inventory.map(item => `
                    <tr>
                        <td>${item.id}</td>
                        <td>${item.batch}</td>
                        <td>${item.quantity}</td>
                        <td>
                            <span class="status-badge status-${item.status}">
                                ${getStatusLabel(item.status)}
                            </span>
                        </td>
                        <td>${new Date(item.receivedAt).toLocaleDateString('sl-SI')}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
    
    listDiv.innerHTML = html;
}

function loadShipments() {
    const stored = localStorage.getItem('distributor_shipments');
    if (stored) {
        shipments = JSON.parse(stored);
    }
    
    const listDiv = document.getElementById('shipment-history');
    
    if (shipments.length === 0) {
        listDiv.innerHTML = '<p class="text-muted">Ni še pošiljk...</p>';
        return;
    }
    
    const html = `
        <table>
            <thead>
                <tr>
                    <th>ID Pošiljke</th>
                    <th>Status</th>
                    <th>Lokacija</th>
                    <th>Posodobljeno</th>
                </tr>
            </thead>
            <tbody>
                ${shipments.map(s => `
                    <tr>
                        <td>${s.id}</td>
                        <td>
                            <span class="status-badge status-${s.status}">
                                ${getStatusLabel(s.status)}
                            </span>
                        </td>
                        <td>${s.location}</td>
                        <td>${new Date(s.updatedAt).toLocaleDateString('sl-SI')}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
    
    listDiv.innerHTML = html;
}

function getStatusLabel(status) {
    const labels = {
        'in_transit': '🚚 V Prometu',
        'in_warehouse': '📦 V Skladišču',
        'ready_for_delivery': '✓ Pripravljeno za Dostavo'
    };
    return labels[status] || status;
}

function clearMessages() {
    document.getElementById('receive-error').style.display = 'none';
    document.getElementById('receive-success').style.display = 'none';
    document.getElementById('shipment-error').style.display = 'none';
    document.getElementById('shipment-success').style.display = 'none';
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
