/**
 * dashboard-pharmacy.js
 * Flow: receive from distributor → inventory
 */

let currentUser = null;
let currentSessionId = null;
let incomingDeliveries = [];
let myInventory = [];

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

        if (currentUser.role !== 'pharmacy') {
            alert('Dostop zavrnjen: Ta nadzorna plošča je samo za lekarne.');
            window.location.href = '/';
            return;
        }

        displayUserProfile();
        ProfilePanel?.setupProfileButton?.(currentSessionId);
        if (!isUserJazmpApproved(currentUser)) {
            setupJazmpApprovalGate(currentUser, { disableSelectors: [] });
        }
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
    navbarTitle.innerHTML = currentUser.companyName || 'Lekarna';
}

function updateWalletStatus() {
    const fullAddress = currentUser.walletAddress;
    const email = currentUser.email;
    const shortAddress = `${fullAddress.slice(0, 6)}...${fullAddress.slice(-4)}`;
    const walletBtn = document.getElementById('wallet-status');

    walletBtn.innerHTML = `${email} | <strong>${shortAddress}</strong>`;
    walletBtn.style.cursor = 'pointer';
    walletBtn.title = 'Klik za profil';
    walletBtn.onclick = () => ProfilePanel?.openProfilePanel?.(currentSessionId);
}

function escapeHtml(unsafe) {
    return String(unsafe ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

async function loadIncomingDeliveries() {
    const listDiv = document.getElementById('incoming-deliveries-list');
    try {
        const response = await fetch(`/api/pharmacy/incoming-deliveries?sessionId=${encodeURIComponent(currentSessionId)}`);
        if (!response.ok) throw new Error('Napaka pri nalaganju dostav');

        const data = await response.json();
        incomingDeliveries = data.deliveries || [];

        if (incomingDeliveries.length === 0) {
            listDiv.innerHTML = '<p class="text-muted">Ni novih dostav od distributorja...</p>';
            return;
        }

        listDiv.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>Zdravilo</th>
                        <th>Serijska</th>
                        <th>Količina</th>
                        <th>Rok</th>
                        <th>Status</th>
                        <th>Akcije</th>
                    </tr>
                </thead>
                <tbody>
                    ${incomingDeliveries.map(d => `
                        <tr>
                            <td>${escapeHtml(d.medicine_name)}</td>
                            <td>${escapeHtml(d.batch_number)}</td>
                            <td>${d.quantity}</td>
                            <td>${formatDisplayDate(d.expiry_date)}</td>
                            <td>${renderStatusBadge(d.status)}</td>
                            <td class="action-cell">
                                <button type="button" class="btn btn-sm btn-preview"
                                    data-medicine-id="${escapeHtml(d.medicine_id)}"
                                    data-delivery-id="${escapeHtml(d.delivery_id)}">Pregled</button>
                                <button type="button" class="btn btn-sm btn-receive" data-delivery-id="${escapeHtml(d.delivery_id)}">Sprejmi</button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;

        listDiv.querySelectorAll('.btn-preview').forEach((btn) => {
            btn.addEventListener('click', async () => {
                try {
                    await openMedicinePreview(btn.dataset.medicineId, currentSessionId, {
                        deliveryId: btn.dataset.deliveryId,
                        onVerify: verifyOnBlockchain
                    });
                } catch (e) {
                    alert(e.message);
                }
            });
        });
        listDiv.querySelectorAll('.btn-receive').forEach(btn => {
            btn.addEventListener('click', () => receiveDelivery(btn.dataset.deliveryId));
        });
    } catch (error) {
        console.error('Error loading deliveries:', error);
        listDiv.innerHTML = '<p class="text-muted">Napaka pri nalaganju dostav.</p>';
    }
}

async function receiveDelivery(deliveryId) {
    try {
        const response = await fetch('/api/pharmacy/receive-delivery', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: currentSessionId,
                deliveryId
            })
        });

        const data = await response.json();
        if (!response.ok) {
            if (response.status === 409 && data.chainPending) {
                throw new Error(formatChainPendingError(data));
            }
            if (response.status === 422 && data.counterfeitAlert) {
                throw new Error(formatCounterfeitError(data));
            }
            throw new Error(data.error || 'Napaka pri sprejemu dostave');
        }

        if (!data.chainHandoff?.autoSigned && data.chainHandoff?.needsBlockchain && window.BlockchainMetaMask) {
            const chainResult = await BlockchainMetaMask.signHandoffAndConfirm(
                currentSessionId,
                data.chainHandoff,
                'RECEIVED_AT_PHARMACY'
            );
            if (!chainResult?.txHash) {
                throw new Error('MetaMask handoff RECEIVED_AT_PHARMACY ni potrjen.');
            }
        } else if (!data.chainHandoff?.autoSigned && data.chainHandoff?.needsBlockchain) {
            throw new Error('Potrdite RECEIVED_AT_PHARMACY v MetaMask.');
        }

        let msg = data.message || 'Dostava sprejeta.';
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
        console.error('Error receiving delivery:', error);
        alert('Napaka: ' + error.message);
    }
}

async function verifyOnBlockchain(medicineId) {
    try {
        const response = await fetch(
            `/api/pharmacy/verify-blockchain?medicineId=${encodeURIComponent(medicineId)}&sessionId=${encodeURIComponent(currentSessionId)}`
        );

        if (!response.ok) {
            throw new Error('Napaka pri preverjanju');
        }

        const result = await response.json();
        let msg = result.message || 'Preverjanje končano.';
        if (result.ipfsLinks) {
            msg += `\n\nIPFS:\n${result.ipfsLinks.ipfsIo}\n${result.ipfsLinks.pinata}`;
        }
        if (result.blockchainExplorer?.tx) {
            msg += `\n\nBlockchain (Etherscan):\n${result.blockchainExplorer.tx}`;
        }
        const icon = result.onChainVerified || result.verified ? '✅' : '⚠️';
        alert(`${icon} ${msg}`);
    } catch (error) {
        alert('Napaka pri preverjanju: ' + error.message);
    }
}

async function loadMyInventory() {
    const listDiv = document.getElementById('my-inventory-list');
    try {
        const response = await fetch(`/api/pharmacy/my-inventory?sessionId=${encodeURIComponent(currentSessionId)}`);
        if (!response.ok) throw new Error('Napaka pri nalaganju inventarja');

        const data = await response.json();
        myInventory = data.inventory || [];

        if (myInventory.length === 0) {
            listDiv.innerHTML = '<p class="text-muted">Inventar je prazen...</p>';
            return;
        }

        listDiv.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>Zdravilo</th>
                        <th>Serijska</th>
                        <th>Količina</th>
                        <th>Rok</th>
                        <th>Status</th>
                        <th>Akcija</th>
                    </tr>
                </thead>
                <tbody>
                    ${myInventory.map(m => `
                        <tr>
                            <td>${escapeHtml(m.name)}</td>
                            <td>${escapeHtml(m.batch_number)}</td>
                            <td>${m.quantity}</td>
                            <td>${formatDisplayDate(m.expiry_date)}</td>
                            <td>${renderStatusBadge(m.blockchain_status, 'medicine')}</td>
                            <td>
                                <button type="button" class="btn btn-sm btn-preview"
                                    data-medicine-id="${escapeHtml(m.medicine_id)}"
                                    data-delivery-id="${escapeHtml(m.delivery_id || '')}">Pregled</button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;

        listDiv.querySelectorAll('.btn-preview').forEach((btn) => {
            btn.addEventListener('click', async () => {
                try {
                    const opts = { onVerify: verifyOnBlockchain };
                    if (btn.dataset.deliveryId) opts.deliveryId = btn.dataset.deliveryId;
                    await openMedicinePreview(btn.dataset.medicineId, currentSessionId, opts);
                } catch (e) {
                    alert(e.message);
                }
            });
        });
    } catch (error) {
        console.error('Error loading inventory:', error);
        listDiv.innerHTML = '<p class="text-muted">Napaka pri nalaganju inventarja.</p>';
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
