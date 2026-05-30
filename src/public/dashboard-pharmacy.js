/**
 * dashboard-pharmacy.js
 * Pharmacy dashboard functionality - visualizer and blockchain verification
 */

let currentUser = null;
let currentSessionId = null;
let incomingDeliveries = [];
let myInventory = [];
let selectedMedicine = null;

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
        
        if (currentUser.role !== 'pharmacy') {
            alert('Dostop zavrnjen: Ta nadzorna plošča je samo za lekarne.');
            window.location.href = '/';
            return;
        }
        
        displayUserProfile();
        attachEventListeners();
        updateWalletStatus();
        await loadIncomingDeliveries();
        await loadMyInventory();
    } catch (error) {
        console.error('Initialization error:', error);
        alert('Napaka pri inicijalizaciji nadzorne plošče');
        sessionStorage.clear();
        window.location.href = '/';
    }
}

function displayUserProfile() {
    const navbarTitle = document.querySelector('.navbar-title');
    const companyNameDisplay = currentUser.companyName ? `${currentUser.companyName}` : '';
    navbarTitle.innerHTML = `${companyNameDisplay}`;
}

function updateWalletStatus() {
    const fullAddress = currentUser.walletAddress;
    const email = currentUser.email;

    const shortAddress = `${fullAddress.slice(0, 6)}...${fullAddress.slice(-4)}`;
    
    const walletBtn = document.getElementById('wallet-status');

    walletBtn.innerHTML = `${email} | <strong>${shortAddress}</strong>`;

    walletBtn.style.cursor = 'pointer';
    walletBtn.title = 'Klikni za kopiranje celotnega naslova';
    walletBtn.style.transition = 'all 0.2s ease';

    walletBtn.onclick = async function() {
        try {
            await navigator.clipboard.writeText(fullAddress);
        } catch (err) {
            console.error('Napaka pri kopiranju v odložišče:', err);
        }
    };
}

function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

async function loadIncomingDeliveries() {
    try {
        const response = await fetch(`/api/pharmacy/incoming-deliveries?sessionId=${encodeURIComponent(currentSessionId)}`);
        if (!response.ok) throw new Error('Napaka pri nalaganju dostav');
        
        const data = await response.json();
        incomingDeliveries = (data.deliveries || data || []);
        
        const listDiv = document.getElementById('incoming-deliveries-list');
        
        if (incomingDeliveries.length === 0) {
            listDiv.innerHTML = '<p class="text-muted">Ni novih dostav...</p>';
            return;
        }
        
        const html = `
            <table>
                <thead>
                    <tr>
                        <th>Zdravilo</th>
                        <th>Pošiljač</th>
                        <th>Serijska Številka</th>
                        <th>Količina</th>
                        <th>Rok</th>
                        <th>Status</th>
                        <th>Akcije</th>
                    </tr>
                </thead>
                <tbody id="deliveries-tbody">
                </tbody>
            </table>
        `;
        
        listDiv.innerHTML = html;
        const tbody = document.getElementById('deliveries-tbody');
        incomingDeliveries.forEach(d => {
            const row = document.createElement('tr');
            const sourceWallet = (d.source_wallet || 'Neznano').substring(0, 10) + '...';
            row.innerHTML = `
                <td>${escapeHtml(d.medicine_name)}</td>
                <td>${escapeHtml(sourceWallet)}</td>
                <td>${escapeHtml(d.batch_number)}</td>
                <td>${d.quantity}</td>
                <td>${escapeHtml(d.expiry_date)}</td>
                <td><span class="badge badge-warning">${escapeHtml(d.status)}</span></td>
                <td>
                    <button class="btn-small btn-receive" data-delivery-id="${d.id}" data-medicine-id="${d.medicine_id}">✓ Sprejmi</button>
                    <button class="btn-small btn-view" data-medicine-id="${d.medicine_id}">👁️ Pregled</button>
                </td>
            `;
            
            row.querySelector('.btn-receive').addEventListener('click', function() {
                const deliveryId = this.getAttribute('data-delivery-id');
                const medicineId = this.getAttribute('data-medicine-id');
                receiveDelivery(deliveryId, medicineId);
            });
            
            row.querySelector('.btn-view').addEventListener('click', function() {
                const medicineId = this.getAttribute('data-medicine-id');
                viewMedicineDetails(medicineId);
            });
            
            tbody.appendChild(row);
        });
    } catch (error) {
        console.error('Error loading deliveries:', error);
    }
}

async function receiveDelivery(deliveryId, medicineId) {
    try {
        const response = await fetch('/api/pharmacy/receive-delivery', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: currentSessionId,
                deliveryId,
                medicineId
            })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || 'Napaka pri sprejemu dostave');
        }
        
        alert('✓ Dostava uspešno sprejeta!');
        await loadIncomingDeliveries();
        await loadMyInventory();
    } catch (error) {
        console.error('Error receiving delivery:', error);
        alert('Napaka: ' + error.message);
    }
}

async function viewMedicineDetails(medicineId) {
    try {
        const response = await fetch(`/api/pharmacy/medicine-details/${medicineId}?sessionId=${encodeURIComponent(currentSessionId)}`);
        if (!response.ok) throw new Error('Napaka pri nalaganju podatkov zdravila');
        
        const medicine = await response.json();
        selectedMedicine = medicine;
        
        displayMedicineVisualizer(medicine);
    } catch (error) {
        console.error('Error loading medicine details:', error);
        alert('Napaka: ' + error.message);
    }
}

function displayMedicineVisualizer(medicine) {
    const visualizerDiv = document.getElementById('medicine-visualizer');
    
    const supplyChainHtml = generateSupplyChainTimeline(medicine);
    const blockchainStatusHtml = generateBlockchainStatus(medicine);
    
    visualizerDiv.innerHTML = `
        <div class="visualizer-container">
            <h3>🏥 Podatki o Zdravilu</h3>
            
            <div class="medicine-info-grid">
                <div class="info-card">
                    <strong>Ime Zdravila</strong>
                    <p>${escapeHtml(medicine.name)}</p>
                </div>
                <div class="info-card">
                    <strong>Serijska Številka</strong>
                    <p>${escapeHtml(medicine.batch_number)}</p>
                </div>
                <div class="info-card">
                    <strong>Količina</strong>
                    <p>${medicine.quantity} enot</p>
                </div>
                <div class="info-card">
                    <strong>Rok Trajanja</strong>
                    <p>${escapeHtml(medicine.expiry_date)}</p>
                </div>
            </div>
            
            <h4>📦 Pot Dostave (Supply Chain)</h4>
            ${supplyChainHtml}
            
            <h4>⛓️ Blockchain Status</h4>
            ${blockchainStatusHtml}
            
            <div class="form-group">
                <button class="btn btn-verify" data-tx-hash="${medicine.blockchain_tx_hash || ''}">
                    🔗 Preveri na Blockchainu
                </button>
            </div>
        </div>
    `;
    
    // Attach event listener to verification button
    const verifyBtn = visualizerDiv.querySelector('.btn-verify');
    if (verifyBtn) {
        verifyBtn.addEventListener('click', function() {
            const txHash = this.getAttribute('data-tx-hash');
            verifyOnBlockchain(txHash);
        });
    }
}

function generateSupplyChainTimeline(medicine) {
    const steps = [
        { role: '🏭 Proizvajalec', date: medicine.created_at, status: 'Ustvarjeno' },
        { role: '📦 IPFS', date: medicine.ipfs_uploaded_at || '...', status: medicine.ipfs_hash ? 'Naloženo' : 'Čakam' },
        { role: '⛓️ Blockchain', date: medicine.blockchain_registered_at || '...', status: medicine.blockchain_status },
        { role: '🚚 Distribucija', date: medicine.forwarded_at || '...', status: medicine.blockchain_status === 'IN_TRANSIT' ? 'V poti' : 'Čakam' },
        { role: '🏥 Lekarno', date: medicine.delivered_at || '...', status: medicine.blockchain_status === 'DELIVERED' ? 'Sprejeto' : 'Čakam' }
    ];
    
    return `
        <div class="timeline">
            ${steps.map((step, idx) => `
                <div class="timeline-item ${idx % 2 === 0 ? 'left' : 'right'}">
                    <div class="timeline-content">
                        <h5>${step.role}</h5>
                        <p><strong>Status:</strong> ${step.status}</p>
                        <p><small>${step.date}</small></p>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

function generateBlockchainStatus(medicine) {
    const isVerified = medicine.blockchain_status === 'REGISTERED' || medicine.blockchain_status === 'DELIVERED';
    const txHash = medicine.blockchain_tx_hash ? escapeHtml(medicine.blockchain_tx_hash.substring(0, 30)) + '...' : 'Ni na voljo';
    const ipfsHash = medicine.ipfs_hash ? escapeHtml(medicine.ipfs_hash.substring(0, 30)) + '...' : 'Ni na voljo';
    const manufacturerWallet = medicine.manufacturer_wallet ? escapeHtml(medicine.manufacturer_wallet.substring(0, 20)) + '...' : 'Ni na voljo';
    
    return `
        <div class="blockchain-status ${isVerified ? 'verified' : 'pending'}">
            <p><strong>Status:</strong> ${escapeHtml(medicine.blockchain_status)}</p>
            <p><strong>IPFS Hash:</strong> <code>${ipfsHash}</code></p>
            <p><strong>TX Hash:</strong> <code>${txHash}</code></p>
            <p><strong>Proizvajalec Wallet:</strong> <code>${manufacturerWallet}</code></p>
            <div style="margin-top: 1rem;">
                ${isVerified ? `
                    <div class="verification-badge verified">
                        ✅ VERIFICIRANO NA BLOCKCHAINU
                    </div>
                ` : `
                    <div class="verification-badge pending">
                        ⏳ ČAKA NA BLOCKCHAIN REGISTRACIJO
                    </div>
                `}
            </div>
        </div>
    `;
}

async function verifyOnBlockchain(txHash) {
    if (!txHash) {
        alert('Transakcija na blockchainu ni na voljo');
        return;
    }
    
    try {
        const response = await fetch(`/api/pharmacy/verify-blockchain?txHash=${encodeURIComponent(txHash)}&sessionId=${encodeURIComponent(currentSessionId)}`);
        
        if (!response.ok) {
            throw new Error('Napaka pri preverjanju na blockchainu');
        }
        
        const result = await response.json();
        
        if (result.verified) {
            alert(`✅ Zdravilo je VERIFICIRANO na blockchainu!\n\nTX: ${txHash.substring(0, 20)}...\nStatus: ${result.status}`);
        } else {
            alert(`⚠️ Zdravilo še ni na blockchainu.\n\nStatus: ${result.status}`);
        }
    } catch (error) {
        console.error('Blockchain verification error:', error);
        alert('Napaka pri preverjanju: ' + error.message);
    }
}

async function loadMyInventory() {
    try {
        const response = await fetch(`/api/pharmacy/my-inventory?sessionId=${encodeURIComponent(currentSessionId)}`);
        if (!response.ok) throw new Error('Napaka pri nalaganju inventarja');
        
        const data = await response.json();
        myInventory = (data.inventory || data || []);
        
        const listDiv = document.getElementById('my-inventory-list');
        
        if (myInventory.length === 0) {
            listDiv.innerHTML = '<p class="text-muted">Inventar je prazen...</p>';
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
                            <td><span class="badge badge-success">${escapeHtml(m.blockchain_status)}</span></td>
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
            await disconnectMetaMask();
        } catch (error) {
            console.error('Logout error:', error);
        } finally {
            sessionStorage.clear();
            window.location.href = '/';
        }
    });
}
