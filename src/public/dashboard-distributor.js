/**
 * dashboard-distributor.js
 * Distributor dashboard functionality
 */

let currentUser = null;
let currentSessionId = null;
let availableMedicines = [];
let myInventory = [];
let selectedMedicines = {};
let pharmacyMap = {}; // Map of wallet address to pharmacy name
let pharmacies = []; // List of available pharmacies

document.addEventListener('DOMContentLoaded', () => {
    initializeDashboard();
});

async function initializeDashboard() {
    try {
        currentSessionId = sessionStorage.getItem('sessionId');
        const userJson = sessionStorage.getItem('user');
        
        if (!currentSessionId || !userJson) {
            window.location.href = '/';
            return;
        }
        
        try {
            const validateResponse = await fetch(`/api/auth/validate-session?sessionId=${encodeURIComponent(currentSessionId)}`);
            if (!validateResponse.ok || !(await validateResponse.json()).valid) {
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

        const userInfoResponse = await fetch(`/api/auth/user-info?sessionId=${encodeURIComponent(currentSessionId)}`);
        if (userInfoResponse.ok) {
            const userInfo = await userInfoResponse.json();
            if (userInfo.user) {
                currentUser = userInfo.user;
                sessionStorage.setItem('user', JSON.stringify(currentUser));
            }
        }
        
        if (currentUser.role !== 'distributor') {
            alert('Dostop zavrnjen: Ta nadzorna plošča je samo za distributerje.');
            window.location.href = '/';
            return;
        }
        
        displayUserProfile();
        attachEventListeners();
        updateWalletStatus();
        await loadPharmacies();
        await loadAvailableMedicines();
        await loadMyInventory();
    } catch (error) {
        console.error('Initialization error:', error);
        alert('Napaka pri inicijalizaciji nadzorne plošče');
        sessionStorage.clear();
        window.location.href = '/';
    }
}

function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function displayUserProfile() {
    const profileDiv = document.getElementById('distributor-profile');
    const email = currentUser.email || 'Ni navedeno';
    profileDiv.innerHTML = `
        <div class="profile-info-item">
            <div class="profile-info-label">Naslov Denarnice</div>
            <div class="profile-info-value">${escapeHtml(currentUser.walletAddress)}</div>
        </div>
        <div class="profile-info-item">
            <div class="profile-info-label">Ime Podjetja</div>
            <div class="profile-info-value">${escapeHtml(currentUser.companyName)}</div>
        </div>
        <div class="profile-info-item">
            <div class="profile-info-label">Email</div>
            <div class="profile-info-value">${escapeHtml(email)}</div>
        </div>
    `;
}

async function loadPharmacies() {
    try {
        const response = await fetch(`/api/pharmacies/list?sessionId=${encodeURIComponent(currentSessionId)}`);
        if (!response.ok) throw new Error('Napaka pri nalaganju lekararn');
        
        const data = await response.json();
        pharmacies = data.pharmacies || [];
        
        // Create mapping of wallet address to pharmacy name
        pharmacyMap = {};
        pharmacies.forEach(p => {
            pharmacyMap[p.walletAddress] = p.name;
        });
    } catch (error) {
        console.error('Error loading pharmacies:', error);
    }
}

function updateWalletStatus() {
    const shortAddress = currentUser.walletAddress.substring(0, 6) + '...' + currentUser.walletAddress.substring(-4);
    document.getElementById('wallet-status').textContent = `✓ Wallet: ${shortAddress}`;
}

async function loadAvailableMedicines() {
    try {
        const response = await fetch(`/api/distributor/available-medicines?sessionId=${encodeURIComponent(currentSessionId)}`);
        if (!response.ok) throw new Error('Napaka pri nalaganju razpoložljivih zdravil');
        
        const data = await response.json();
        availableMedicines = (data.medicines || data || []);
        
        const listDiv = document.getElementById('available-medicines-list');
        
        if (availableMedicines.length === 0) {
            listDiv.innerHTML = '<p class="text-muted">Ni razpoložljivih zdravil za distribucijo...</p>';
            return;
        }
        
        const html = `
            <table>
                <thead>
                    <tr>
                        <th>Zdravilo</th>
                        <th>Proizvajalec</th>
                        <th>Serijska Številka</th>
                        <th>Količina</th>
                        <th>Rok</th>
                        <th>Status</th>
                        <th>Akcija</th>
                    </tr>
                </thead>
                <tbody id="medicines-tbody">
                </tbody>
            </table>
        `;
        
        listDiv.innerHTML = html;
        const tbody = document.getElementById('medicines-tbody');
        availableMedicines.forEach(m => {
            const row = document.createElement('tr');
            const manufacturerWallet = (m.manufacturer_wallet || 'Neznano').substring(0, 10) + '...';
            row.innerHTML = `
                <td>${escapeHtml(m.name)}</td>
                <td>${escapeHtml(manufacturerWallet)}</td>
                <td>${escapeHtml(m.batch_number)}</td>
                <td>${m.quantity}</td>
                <td>${escapeHtml(m.expiry_date)}</td>
                <td><span class="badge badge-success">${escapeHtml(m.blockchain_status)}</span></td>
                <td>
                    <button class="btn-small btn-select" data-medicine-id="${m.id}" data-medicine-name="${m.name}" data-quantity="${m.quantity}">
                        📦 Izberi
                    </button>
                </td>
            `;
            
            row.querySelector('.btn-select').addEventListener('click', function() {
                const medicineId = this.getAttribute('data-medicine-id');
                const medicineName = this.getAttribute('data-medicine-name');
                const quantity = this.getAttribute('data-quantity');
                selectMedicineForForwarding(medicineId, medicineName, parseInt(quantity));
            });
            
            tbody.appendChild(row);
        });
    } catch (error) {
        console.error('Error loading available medicines:', error);
    }
}

function selectMedicineForForwarding(medicineId, medicineName, availableQuantity) {
    const forwardDiv = document.getElementById('forward-medicine-panel');
    
    // Create pharmacy options HTML
    let pharmacyOptionsHtml = '<option value="">-- Izbira --</option>';
    if (pharmacies.length === 0) {
        pharmacyOptionsHtml = '<option value="" disabled>Ni dostopnih lekararn</option>';
    } else {
        pharmacies.forEach(p => {
            pharmacyOptionsHtml += `<option value="${p.walletAddress}">${escapeHtml(p.name)}</option>`;
        });
    }
    
    forwardDiv.innerHTML = `
        <h3>📦 Pošlji zdravilo v lekarno</h3>
        <div class="form-group">
            <label>Zdravilo: <strong>${escapeHtml(medicineName)}</strong></label>
        </div>
        <div class="form-group">
            <label>Količina (Max: ${availableQuantity})</label>
            <input type="number" id="forward-quantity" min="1" max="${availableQuantity}" value="${availableQuantity}">
        </div>
        <div class="form-group">
            <label>Ciljna Lekarno</label>
            <select id="target-pharmacy" class="form-control">
                ${pharmacyOptionsHtml}
            </select>
        </div>
        <button class="btn btn-forward">🚚 Pošlji v Lekarno</button>
    `;
    
    forwardDiv.querySelector('.btn-forward').addEventListener('click', function() {
        forwardMedicineToPharmacy(medicineId);
    });
}

async function forwardMedicineToPharmacy(medicineId) {
    try {
        const quantity = parseInt(document.getElementById('forward-quantity').value);
        const targetPharmacyWallet = document.getElementById('target-pharmacy').value;
        
        if (!quantity || quantity < 1) {
            alert('Vnesite veljavno količino');
            return;
        }
        
        if (!targetPharmacyWallet) {
            alert('Izberite lekarno');
            return;
        }
        
        const response = await fetch('/api/distributor/send-to-pharmacy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: currentSessionId,
                medicineId,
                quantity,
                targetPharmacyName: pharmacyMap[targetPharmacyWallet] || '',
                targetPharmacyWallet
            })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || 'Napaka pri pošiljanju zdravila');
        }
        
        alert('✓ Zdravilo uspešno poslano v lekarno!');
        document.getElementById('forward-medicine-panel').innerHTML = '';
        await loadAvailableMedicines();
        await loadMyInventory();
    } catch (error) {
        console.error('Error forwarding medicine:', error);
        alert('Napaka: ' + error.message);
    }
}

async function loadMyInventory() {
    try {
        const response = await fetch(`/api/distributor/my-inventory?sessionId=${encodeURIComponent(currentSessionId)}`);
        if (!response.ok) throw new Error('Napaka pri nalaganju inventarja');
        
        const data = await response.json();
        myInventory = (data.inventory || data || []);
        
        const listDiv = document.getElementById('my-inventory-list');
        
        if (myInventory.length === 0) {
            listDiv.innerHTML = '<p class="text-muted">Prazno. Najprej sprejmite zdravila od proizvajalca.</p>';
            return;
        }
        
        const html = `
            <table>
                <thead>
                    <tr>
                        <th>Zdravilo</th>
                        <th>Serijska Številka</th>
                        <th>Količina</th>
                        <th>Rok</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${myInventory.map(m => `
                        <tr>
                            <td>${escapeHtml(m.name)}</td>
                            <td>${escapeHtml(m.batch_number)}</td>
                            <td>${m.quantity}</td>
                            <td>${escapeHtml(m.expiry_date)}</td>
                            <td><span class="badge badge-info">${escapeHtml(m.status || m.blockchain_status)}</span></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        
        listDiv.innerHTML = html;
    } catch (error) {
        console.error('Error loading inventory:', error);
    }
}

function attachEventListeners() {
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
}
