/**
 * dashboard-distributor.js
 * Flow: receive from manufacturer → forward to pharmacy
 */

let currentUser = null;
let currentSessionId = null;
let myInventory = [];
let pharmacyMap = {};
let pharmacies = [];

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

        const validateResponse = await fetch(`/api/auth/validate-session?sessionId=${encodeURIComponent(currentSessionId)}`);
        if (!validateResponse.ok || !(await validateResponse.json()).valid) {
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
        await tryEnsureOnChainUser(currentSessionId, currentUser);

        if (currentUser.role !== 'distributor') {
            alert('Dostop zavrnjen: Ta nadzorna plošča je samo za distributerje.');
            window.location.href = '/';
            return;
        }

        displayUserProfile();
        attachEventListeners();
        updateWalletStatus();
        await loadPharmacies();
        await loadIncomingDeliveries();
        await loadMyInventory();
        await loadOutgoingDeliveries();
    } catch (error) {
        console.error('Initialization error:', error);
        alert('Napaka pri inicijalizaciji nadzorne plošče');
        sessionStorage.clear();
        window.location.href = '/';
    }
}

function escapeHtml(unsafe) {
    return String(unsafe ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function displayUserProfile() {
    const navbarTitle = document.querySelector('.navbar-title');
    navbarTitle.innerHTML = currentUser.companyName || 'Distributor';
}

async function loadPharmacies() {
    try {
        const response = await fetch(`/api/pharmacies/list?sessionId=${encodeURIComponent(currentSessionId)}`);
        if (!response.ok) throw new Error('Napaka pri nalaganju lekarn');

        const data = await response.json();
        pharmacies = data.pharmacies || [];
        pharmacyMap = {};
        pharmacies.forEach(p => {
            pharmacyMap[p.walletAddress] = p.name;
        });
    } catch (error) {
        console.error('Error loading pharmacies:', error);
    }
}

function updateWalletStatus() {
    const fullAddress = currentUser.walletAddress;
    const email = currentUser.email;
    const shortAddress = `${fullAddress.slice(0, 6)}...${fullAddress.slice(-4)}`;
    const walletBtn = document.getElementById('wallet-status');

    walletBtn.innerHTML = `${email} | <strong>${shortAddress}</strong>`;
    walletBtn.style.cursor = 'pointer';
    walletBtn.title = 'Klikni za kopiranje celotnega naslova';
    walletBtn.onclick = async () => {
        try {
            await navigator.clipboard.writeText(fullAddress);
        } catch (err) {
            console.error('Napaka pri kopiranju:', err);
        }
    };
}

async function loadIncomingDeliveries() {
    const listDiv = document.getElementById('incoming-deliveries-list');
    try {
        const response = await fetch(`/api/distributor/incoming-deliveries?sessionId=${encodeURIComponent(currentSessionId)}`);
        if (!response.ok) throw new Error('Napaka pri nalaganju dostav');

        const data = await response.json();
        const deliveries = data.deliveries || [];

        if (deliveries.length === 0) {
            listDiv.innerHTML = '<p class="text-muted">Ni novih pošiljk od proizvajalcev...</p>';
            return;
        }

        listDiv.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>Zdravilo</th>
                        <th>Proizvajalec</th>
                        <th>Serijska</th>
                        <th>Količina</th>
                        <th>Rok</th>
                        <th>Akcija</th>
                    </tr>
                </thead>
                <tbody>
                    ${deliveries.map(d => `
                        <tr>
                            <td>${escapeHtml(d.medicine_name)}</td>
                            <td>${escapeHtml(d.manufacturer_name)}</td>
                            <td>${escapeHtml(d.batch_number)}</td>
                            <td>${d.quantity}</td>
                            <td>${formatDisplayDate(d.expiry_date)}</td>
                            <td class="action-cell">
                                <button type="button" class="btn-small btn-preview" data-medicine-id="${escapeHtml(d.medicine_id)}" data-delivery-id="${escapeHtml(d.delivery_id)}">Pregled</button>
                                <button type="button" class="btn-small btn-receive" data-delivery-id="${escapeHtml(d.delivery_id)}">Sprejmi</button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;

        listDiv.querySelectorAll('.btn-preview').forEach((btn) => {
            btn.addEventListener('click', async () => {
                try {
                    await openMedicinePreview(btn.dataset.medicineId, currentSessionId, btn.dataset.deliveryId);
                } catch (e) {
                    alert(e.message);
                }
            });
        });
        listDiv.querySelectorAll('.btn-receive').forEach(btn => {
            btn.addEventListener('click', () => receiveFromManufacturer(btn.dataset.deliveryId));
        });
    } catch (error) {
        console.error('Error loading incoming deliveries:', error);
        listDiv.innerHTML = '<p class="text-muted">Napaka pri nalaganju dostav.</p>';
    }
}

async function receiveFromManufacturer(deliveryId) {
    try {
        const response = await fetch('/api/distributor/receive-delivery', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: currentSessionId, deliveryId })
        });

        const data = await response.json();
        if (!response.ok) {
            if (response.status === 422 && data.counterfeitAlert) {
                throw new Error(formatCounterfeitError(data));
            }
            throw new Error(data.error || 'Napaka pri sprejemu');
        }

        if (data.chainHandoff?.needsBlockchain && window.BlockchainMetaMask) {
            const chainResult = await BlockchainMetaMask.signHandoffAndConfirm(
                currentSessionId,
                data.chainHandoff,
                'RECEIVED_BY_DISTRIBUTOR'
            );
            if (!chainResult?.txHash) {
                throw new Error('MetaMask handoff RECEIVED_BY_DISTRIBUTOR ni potrjen.');
            }
        } else if (data.chainHandoff?.needsBlockchain) {
            throw new Error('Potrdite RECEIVED_BY_DISTRIBUTOR v MetaMask (Sepolia).');
        }

        let msg = data.message || 'Pošiljka sprejeta.';
        if (data.verification) msg += '\n\n' + formatVerificationAlert(data.verification);
        alert(msg);

        await promptPartnerReputation({
            sessionId: currentSessionId,
            deliveryId,
            partnerWallet: data.partnerWallet
        });
        await loadIncomingDeliveries();
        await loadMyInventory();
    } catch (error) {
        alert('Napaka: ' + error.message);
    }
}

async function loadMyInventory() {
    const listDiv = document.getElementById('my-inventory-list');
    try {
        const response = await fetch(`/api/distributor/my-inventory?sessionId=${encodeURIComponent(currentSessionId)}`);
        if (!response.ok) throw new Error('Napaka pri nalaganju inventarja');

        const data = await response.json();
        myInventory = data.inventory || [];

        if (myInventory.length === 0) {
            listDiv.innerHTML = '<p class="text-muted">Inventar je prazen. Najprej sprejmite pošiljko od proizvajalca.</p>';
            document.getElementById('forward-medicine-panel').innerHTML = '';
            return;
        }

        listDiv.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>Zdravilo</th>
                        <th>Serijska</th>
                        <th>Na voljo</th>
                        <th>Rok</th>
                        <th>Akcija</th>
                    </tr>
                </thead>
                <tbody>
                    ${myInventory.map(m => `
                        <tr>
                            <td>${escapeHtml(m.name)}</td>
                            <td>${escapeHtml(m.batch_number)}</td>
                            <td>${m.available_quantity} enot</td>
                            <td>${formatDisplayDate(m.expiry_date)}</td>
                            <td>
                                <button type="button" class="btn-small btn-details" data-medicine-id="${escapeHtml(m.medicine_id)}">Pregled</button>
                                <button class="btn-small btn-forward"
                                    data-medicine-id="${escapeHtml(m.medicine_id)}"
                                    data-medicine-name="${escapeHtml(m.name)}"
                                    data-quantity="${m.available_quantity}">
                                    🚚 Pošlji
                                </button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;

        listDiv.querySelectorAll('.btn-forward').forEach(btn => {
            btn.addEventListener('click', () => {
                showForwardPanel(
                    btn.dataset.medicineId,
                    btn.dataset.medicineName,
                    parseInt(btn.dataset.quantity, 10)
                );
            });
        });
        listDiv.querySelectorAll('.btn-details').forEach((btn) => {
            btn.addEventListener('click', async () => {
                try { await openMedicinePreview(btn.dataset.medicineId, currentSessionId); } catch (e) { alert(e.message); }
            });
        });
    } catch (error) {
        console.error('Error loading inventory:', error);
        listDiv.innerHTML = '<p class="text-muted">Napaka pri nalaganju inventarja.</p>';
    }
}

function showForwardPanel(medicineId, medicineName, availableQuantity) {
    const forwardDiv = document.getElementById('forward-medicine-panel');

    let pharmacyOptions = '<option value="">-- Izberite lekarno --</option>';
    if (pharmacies.length === 0) {
        pharmacyOptions = '<option value="" disabled>Ni registriranih lekarn</option>';
    } else {
        pharmacies.forEach(p => {
            pharmacyOptions += `<option value="${p.walletAddress}">${escapeHtml(p.name)}</option>`;
        });
    }

    forwardDiv.innerHTML = `
        <h3>🚚 Pošlji v lekarno: ${escapeHtml(medicineName)}</h3>
        <div class="form-group">
            <label for="forward-quantity">Količina (max ${availableQuantity})</label>
            <input type="number" id="forward-quantity" class="form-control" min="1" max="${availableQuantity}" value="${availableQuantity}">
        </div>
        <div class="form-group">
            <label for="target-pharmacy">Ciljna lekarna</label>
            <select id="target-pharmacy" class="form-control">${pharmacyOptions}</select>
        </div>
        <button id="btn-confirm-forward" class="btn btn-primary">📦 Potrdi pošiljko</button>
        <p id="forward-error" class="error-message" style="display:none;"></p>
        <p id="forward-success" class="success-message" style="display:none;"></p>
    `;

    document.getElementById('btn-confirm-forward').addEventListener('click', () => {
        forwardMedicineToPharmacy(medicineId);
    });
}

async function forwardMedicineToPharmacy(medicineId) {
    const errorEl = document.getElementById('forward-error');
    const successEl = document.getElementById('forward-success');
    errorEl.style.display = 'none';
    successEl.style.display = 'none';

    try {
        const quantity = parseInt(document.getElementById('forward-quantity').value, 10);
        const targetPharmacyWallet = document.getElementById('target-pharmacy').value;

        if (!quantity || quantity < 1) {
            throw new Error('Vnesite veljavno količino');
        }
        if (!targetPharmacyWallet) {
            throw new Error('Izberite lekarno');
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

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'Napaka pri pošiljanju');
        }

        if (data.chainHandoff?.needsBlockchain && window.BlockchainMetaMask) {
            const chainResult = await BlockchainMetaMask.signHandoffAndConfirm(
                currentSessionId,
                data.chainHandoff,
                'FORWARDED_TO_PHARMACY'
            );
            if (!chainResult?.txHash) {
                throw new Error('MetaMask handoff FORWARDED_TO_PHARMACY ni potrjen — lekarna ne bo mogla prevzeti.');
            }
        } else if (data.chainHandoff?.needsBlockchain) {
            throw new Error('Potrdite FORWARDED_TO_PHARMACY v MetaMask (Sepolia).');
        }

        successEl.textContent = `✓ Poslano v ${pharmacyMap[targetPharmacyWallet]} (VC + veriga)`;
        successEl.style.display = 'block';
        await loadMyInventory();
        await loadOutgoingDeliveries();
    } catch (error) {
        errorEl.textContent = error.message;
        errorEl.style.display = 'block';
    }
}

async function loadOutgoingDeliveries() {
    const listDiv = document.getElementById('shipment-history-list');
    try {
        const response = await fetch(`/api/distributor/outgoing-deliveries?sessionId=${encodeURIComponent(currentSessionId)}`);
        if (!response.ok) throw new Error('Napaka pri nalaganju zgodovine');

        const data = await response.json();
        const deliveries = data.deliveries || [];

        if (deliveries.length === 0) {
            listDiv.innerHTML = '<p class="text-muted">Ni še poslanih pošiljk v lekarne...</p>';
            return;
        }

        listDiv.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>Zdravilo</th>
                        <th>Lekarna</th>
                        <th>Količina</th>
                        <th>Status</th>
                        <th>Datum</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    ${deliveries.map(d => `
                        <tr>
                            <td>${escapeHtml(d.medicine_name)}</td>
                            <td>${escapeHtml(d.pharmacy_name)}</td>
                            <td>${d.quantity}</td>
                            <td>${renderStatusBadge(d.status)}</td>
                            <td>${formatDisplayDate(d.created_at)}</td>
                            <td><button type="button" class="btn-small btn-details" data-medicine-id="${escapeHtml(d.medicine_id)}">Pregled</button></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        listDiv.querySelectorAll('.btn-details').forEach((btn) => {
            btn.addEventListener('click', async () => {
                try { await openMedicinePreview(btn.dataset.medicineId, currentSessionId); } catch (e) { alert(e.message); }
            });
        });
    } catch (error) {
        console.error('Error loading outgoing deliveries:', error);
        listDiv.innerHTML = '<p class="text-muted">Napaka pri nalaganju zgodovine.</p>';
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
