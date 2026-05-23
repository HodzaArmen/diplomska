/**
 * dashboard-pharmacy.js
 * Pharmacy dashboard functionality
 */

let currentUser = null;
let currentSessionId = null;
let pharmacyInventory = [];
let deliveries = [];

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
        
        currentUser = JSON.parse(userJson);
        
        // Check if user is pharmacy
        if (currentUser.role !== 'pharmacy') {
            alert('Dostop zavrnjen: Ta nadzorna plošča je samo za lekarne.');
            window.location.href = '/';
            return;
        }
        
        displayUserProfile();
        attachEventListeners();
        updateWalletStatus();
        loadPharmacyInventory();
        loadDeliveries();
    } catch (error) {
        console.error('Initialization error:', error);
        alert('Napaka pri inicijalizaciji nadzorne plošče');
        window.location.href = '/';
    }
}

function displayUserProfile() {
    const profileDiv = document.getElementById('pharmacy-profile');
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
    document.getElementById('btn-back-home').addEventListener('click', () => {
        window.location.href = '/';
    });
    
    // Verify medicine
    document.getElementById('btn-verify-medicine').addEventListener('click', verifyMedicine);
    
    // Receive from distributor
    document.getElementById('btn-receive-from-distributor').addEventListener('click', receiveFromDistributor);
    
    // Trace medicine
    document.getElementById('btn-trace-medicine').addEventListener('click', traceMedicine);
}

async function verifyMedicine() {
    try {
        clearMessages();
        
        const medicineId = document.getElementById('medicine-id-verify').value;
        const batchNumber = document.getElementById('batch-number-verify').value;
        
        if (!medicineId || !batchNumber) {
            showError('verify-error', 'Prosimo izpolnite vsa polja');
            return;
        }
        
        const btn = document.getElementById('btn-verify-medicine');
        btn.disabled = true;
        btn.textContent = 'Preverujem...';
        
        // In a real implementation, this would verify against Walt.id Verifier API
        // For now, we simulate a successful verification
        const result = {
            medicineId,
            batchNumber,
            status: 'VERIFIED',
            authenticity: true,
            manufacturer: 'Unknown Manufacturer',
            issuanceDate: new Date(Date.now() - 30*24*60*60*1000).toLocaleDateString('sl-SI'),
            expiryDate: new Date(Date.now() + 365*24*60*60*1000).toLocaleDateString('sl-SI')
        };
        
        showSuccess('verify-success', '✓ Zdravilo je avtentično!');
        displayVerificationResult(result);
    } catch (error) {
        console.error('Error verifying medicine:', error);
        showError('verify-error', 'Napaka: ' + error.message);
    } finally {
        const btn = document.getElementById('btn-verify-medicine');
        btn.disabled = false;
        btn.textContent = 'Preveri Avtentičnost';
    }
}

function displayVerificationResult(result) {
    const resultDiv = document.getElementById('verify-result');
    resultDiv.innerHTML = `
        <div class="result-item">
            <span class="result-label">ID Zdravila:</span>
            <span class="result-value">${result.medicineId}</span>
        </div>
        <div class="result-item">
            <span class="result-label">Serijska Številka:</span>
            <span class="result-value">${result.batchNumber}</span>
        </div>
        <div class="result-item">
            <span class="result-label">Status:</span>
            <span class="result-value" style="color: #059669; font-weight: bold;">${result.status}</span>
        </div>
        <div class="result-item">
            <span class="result-label">Avtentičnost:</span>
            <span class="result-value" style="color: #059669;">${result.authenticity ? '✓ Avtentično' : '✗ Neavtentično'}</span>
        </div>
        <div class="result-item">
            <span class="result-label">Proizvajalec:</span>
            <span class="result-value">${result.manufacturer}</span>
        </div>
        <div class="result-item">
            <span class="result-label">Datum Izdaje:</span>
            <span class="result-value">${result.issuanceDate}</span>
        </div>
        <div class="result-item">
            <span class="result-label">Rok Trajanja:</span>
            <span class="result-value">${result.expiryDate}</span>
        </div>
    `;
    resultDiv.style.display = 'block';
}

async function receiveFromDistributor() {
    try {
        clearMessages();
        
        const medicineId = document.getElementById('medicine-id-pharmacy-receive').value;
        const quantity = document.getElementById('quantity-pharmacy-receive').value;
        
        if (!medicineId || !quantity) {
            showError('pharmacy-receive-error', 'Prosimo izpolnite vsa polja');
            return;
        }
        
        const btn = document.getElementById('btn-receive-from-distributor');
        btn.disabled = true;
        btn.textContent = 'Potvrjujem...';
        
        // Add to pharmacy inventory
        const item = {
            id: medicineId,
            quantity: parseInt(quantity),
            receivedAt: new Date().toISOString(),
            status: 'in_stock'
        };
        
        pharmacyInventory.push(item);
        localStorage.setItem('pharmacy_inventory', JSON.stringify(pharmacyInventory));
        
        showSuccess('pharmacy-receive-success', '✓ Zdravilo je bilo uspešno prevzeto!');
        
        // Clear form
        document.getElementById('medicine-id-pharmacy-receive').value = '';
        document.getElementById('quantity-pharmacy-receive').value = '';
        
        // Reload inventory
        loadPharmacyInventory();
    } catch (error) {
        console.error('Error receiving from distributor:', error);
        showError('pharmacy-receive-error', 'Napaka: ' + error.message);
    } finally {
        const btn = document.getElementById('btn-receive-from-distributor');
        btn.disabled = false;
        btn.textContent = 'Potrdi Sprejem';
    }
}

async function traceMedicine() {
    try {
        clearMessages();
        
        const medicineId = document.getElementById('medicine-id-trace').value;
        
        if (!medicineId) {
            showError('trace-error', 'Prosimo vnesite ID zdravila');
            return;
        }
        
        const btn = document.getElementById('btn-trace-medicine');
        btn.disabled = true;
        btn.textContent = 'Preurim...';
        
        // In a real implementation, this would query the blockchain
        // For now, we simulate a trace result
        const traceData = {
            medicineId,
            chain: [
                {
                    step: 1,
                    actor: 'Proizvajalec',
                    action: 'Proizvedeno',
                    timestamp: new Date(Date.now() - 60*24*60*60*1000).toISOString(),
                    location: 'Tovarna'
                },
                {
                    step: 2,
                    actor: 'Distributor',
                    action: 'Prevzeto',
                    timestamp: new Date(Date.now() - 45*24*60*60*1000).toISOString(),
                    location: 'Skladišče'
                },
                {
                    step: 3,
                    actor: 'Distributor',
                    action: 'Poslano',
                    timestamp: new Date(Date.now() - 30*24*60*60*1000).toISOString(),
                    location: 'V Prometu'
                },
                {
                    step: 4,
                    actor: 'Lekarna',
                    action: 'Prevzeto',
                    timestamp: new Date(Date.now() - 1*24*60*60*1000).toISOString(),
                    location: 'Lekarna Ljubljana'
                }
            ]
        };
        
        displayTraceResult(traceData);
    } catch (error) {
        console.error('Error tracing medicine:', error);
        showError('trace-error', 'Napaka: ' + error.message);
    } finally {
        const btn = document.getElementById('btn-trace-medicine');
        btn.disabled = false;
        btn.textContent = 'Preurite Sledljivost';
    }
}

function displayTraceResult(traceData) {
    const resultDiv = document.getElementById('trace-result');
    
    const chainHtml = traceData.chain.map(entry => `
        <div class="result-item">
            <span class="result-label">${entry.step}. ${entry.actor}</span>
            <span class="result-value">
                <strong>${entry.action}</strong><br>
                📍 ${entry.location}<br>
                🕐 ${new Date(entry.timestamp).toLocaleString('sl-SI')}
            </span>
        </div>
    `).join('');
    
    resultDiv.innerHTML = `<h3>Sledljivost Zdravila: ${traceData.medicineId}</h3>${chainHtml}`;
    resultDiv.style.display = 'block';
}

function loadPharmacyInventory() {
    const stored = localStorage.getItem('pharmacy_inventory');
    if (stored) {
        pharmacyInventory = JSON.parse(stored);
    }
    
    const listDiv = document.getElementById('pharmacy-inventory');
    
    if (pharmacyInventory.length === 0) {
        listDiv.innerHTML = '<p class="text-muted">Ni še prevzetih zdravil...</p>';
        return;
    }
    
    const html = `
        <table>
            <thead>
                <tr>
                    <th>ID Zdravila</th>
                    <th>Količina</th>
                    <th>Status</th>
                    <th>Prevzeto</th>
                </tr>
            </thead>
            <tbody>
                ${pharmacyInventory.map(item => `
                    <tr>
                        <td>${item.id}</td>
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

function loadDeliveries() {
    const stored = localStorage.getItem('pharmacy_deliveries');
    if (stored) {
        deliveries = JSON.parse(stored);
    }
    
    const listDiv = document.getElementById('recent-deliveries');
    
    if (deliveries.length === 0) {
        listDiv.innerHTML = '<p class="text-muted">Ni še dostav...</p>';
        return;
    }
    
    const html = `
        <table>
            <thead>
                <tr>
                    <th>ID Dostave</th>
                    <th>Vsebina</th>
                    <th>Status</th>
                    <th>Prejeto</th>
                </tr>
            </thead>
            <tbody>
                ${deliveries.map(d => `
                    <tr>
                        <td>${d.id}</td>
                        <td>${d.items} postavk</td>
                        <td>
                            <span class="status-badge status-${d.status}">
                                ${getStatusLabel(d.status)}
                            </span>
                        </td>
                        <td>${new Date(d.receivedAt).toLocaleDateString('sl-SI')}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
    
    listDiv.innerHTML = html;
}

function getStatusLabel(status) {
    const labels = {
        'in_stock': '✓ V Zalogi',
        'in_transit': '🚚 V Prometu',
        'received': '📥 Prejeto',
        'verified': '✓ Preverjeno'
    };
    return labels[status] || status;
}

function clearMessages() {
    document.getElementById('verify-error').style.display = 'none';
    document.getElementById('verify-success').style.display = 'none';
    document.getElementById('pharmacy-receive-error').style.display = 'none';
    document.getElementById('pharmacy-receive-success').style.display = 'none';
    document.getElementById('trace-error').style.display = 'none';
    document.getElementById('verify-result').style.display = 'none';
    document.getElementById('trace-result').style.display = 'none';
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
