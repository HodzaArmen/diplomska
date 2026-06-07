/**
 * dashboard-manufacturer.js
 */

let currentUser = null;
let currentSessionId = null;
let medicines = [];
let medicineTemplates = [];
let distributorMap = {};

document.addEventListener('DOMContentLoaded', () => {
    initializeDashboard();
});

async function refreshUserFromServer() {
    const response = await fetch(`/api/auth/user-info?sessionId=${encodeURIComponent(currentSessionId)}`);
    if (!response.ok) throw new Error('Napaka pri nalaganju profila');
    const data = await response.json();
    if (data.user) {
        currentUser = data.user;
        sessionStorage.setItem('user', JSON.stringify(currentUser));
    }
}

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
        await refreshUserFromServer();

        if (currentUser.role !== 'manufacturer') {
            alert('Dostop zavrnjen: Ta nadzorna plošča je samo za proizvajalce.');
            window.location.href = '/';
            return;
        }

        displayUserProfile();
        await loadMedicineTemplates();
        await loadDistributors();
        attachEventListeners();
        updateWalletStatus();
        await loadMyMedicines();
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

async function loadMedicineTemplates() {
    try {
        const response = await fetch(`/api/medicines/templates?sessionId=${encodeURIComponent(currentSessionId)}`);
        if (!response.ok) throw new Error('Napaka pri nalaganju šablon');

        const data = await response.json();
        medicineTemplates = data.templates || [];

        const select = document.getElementById('medicine-selection');
        medicineTemplates.forEach(template => {
            const option = document.createElement('option');
            const templateName = template.template_name || template.name;
            option.value = templateName;
            option.textContent = templateName;
            select.appendChild(option);
        });

        const customOption = document.createElement('option');
        customOption.value = 'custom';
        customOption.textContent = '+ Dodaj Custom Zdravilo';
        select.appendChild(customOption);
    } catch (error) {
        console.error('Error loading templates:', error);
    }
}

async function loadDistributors() {
    try {
        const response = await fetch(`/api/distributors/list?sessionId=${encodeURIComponent(currentSessionId)}`);
        if (!response.ok) throw new Error('Napaka pri nalaganju distributorjev');

        const data = await response.json();
        const distributors = data.distributors || [];

        distributorMap = {};
        const select = document.getElementById('target-distributor');
        while (select.options.length > 1) {
            select.remove(1);
        }

        distributors.forEach(distributor => {
            distributorMap[distributor.walletAddress] = distributor.name;
            const option = document.createElement('option');
            option.value = distributor.walletAddress;
            option.textContent = distributor.name;
            select.appendChild(option);
        });

        if (distributors.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'Ni registriranih distributorjev';
            option.disabled = true;
            select.appendChild(option);
        }
    } catch (error) {
        console.error('Error loading distributors:', error);
    }
}

function updateDeliveryMedicineSelect() {
    const select = document.getElementById('delivery-medicine');
    while (select.options.length > 1) {
        select.remove(1);
    }

    medicines.forEach(m => {
        const medicineId = m.medicine_id || m.medicineId;
        const available = m.available_quantity ?? m.quantity;
        const option = document.createElement('option');
        option.value = medicineId;
        option.textContent = `${m.name} (${medicineId}) — ${available} na voljo`;
        option.dataset.maxQuantity = available;
        select.appendChild(option);
    });
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

    document.getElementById('medicine-selection').addEventListener('change', (e) => {
        document.getElementById('custom-medicine-group').style.display =
            e.target.value === 'custom' ? 'block' : 'none';
    });

    document.getElementById('btn-create-medicine').addEventListener('click', createMedicine);
    document.getElementById('btn-send-delivery').addEventListener('click', sendToDistributor);
}

async function createMedicine() {
    try {
        clearMessages('create');

        const medicineSelection = document.getElementById('medicine-selection').value;
        const customMedicineName = document.getElementById('custom-medicine-name').value;
        const batchNumber = document.getElementById('batch-number').value;
        const quantity = document.getElementById('quantity').value;
        const expiryDate = document.getElementById('expiry-date').value;
        const description = document.getElementById('description').value;

        let medicineName = medicineSelection;

        if (!medicineSelection) {
            showError('create-error', 'Prosimo izberite ali dodajte zdravilo');
            return;
        }

        if (medicineSelection === 'custom') {
            if (!customMedicineName) {
                showError('create-error', 'Prosimo vnesite ime custom zdravila');
                return;
            }
            medicineName = customMedicineName;
        }

        if (!batchNumber || !quantity || !expiryDate) {
            showError('create-error', 'Prosimo izpolnite serijsko številko, količino in datum poteka');
            return;
        }

        const btn = document.getElementById('btn-create-medicine');
        btn.disabled = true;
        btn.textContent = '⏳ Ustvarjam...';

        const response = await fetch('/api/medicines/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: currentSessionId,
                medicineName,
                batchNumber,
                quantity: parseInt(quantity, 10),
                expiryDate,
                description
            })
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'Napaka pri ustvarjanju zdravila');
        }

        const medicine = data.medicine || data;
        const warnings = data.warnings || [];

        if (!medicine.ipfsHash) {
            const detail = medicine.ipfsError || warnings.join(' · ') || 'IPFS upload ni uspel';
            showError('create-error', `Zdravilo je v bazi, vendar brez IPFS: ${detail}. Preveri GET /api/system/status in src/.env (Pinata), nato docker compose restart app.`);
        }

        let successMsg = data.fullyIntegrated
            ? '✓ Zdravilo ustvarjeno (Walt.id VC + IPFS + blockchain)!'
            : '⚠ Zdravilo shranjeno — nekateri koraki niso uspeli:';

        if (medicine.vcSigned) successMsg += '<br>• Podpisani VC (issuer-api)';
        if (medicine.ipfsHash) {
            const links = getIpfsGatewayLinks(medicine.ipfsHash);
            successMsg += `<br>• IPFS: <a href="${links.ipfsIo}" target="_blank" rel="noopener">ipfs.io</a> | <a href="${links.pinata}" target="_blank" rel="noopener">Pinata</a> (${links.hash})`;
        }
        if (medicine.blockchainTxHash) {
            const ex = medicine.blockchainExplorer?.tx;
            successMsg += ex
                ? `<br>• TX: <a href="${ex}" target="_blank" rel="noopener">Etherscan</a> <code>${medicine.blockchainTxHash.slice(0, 20)}…</code>`
                : `<br>• TX: <code>${medicine.blockchainTxHash}</code>`;
        }
        if (warnings.length && !data.fullyIntegrated) {
            successMsg += `<br><small>${warnings.join('<br>')}</small>`;
        }

        if (medicine.ipfsHash) {
            showSuccess('create-success', successMsg, true);
        }

        document.getElementById('medicine-selection').value = '';
        document.getElementById('custom-medicine-name').value = '';
        document.getElementById('batch-number').value = '';
        document.getElementById('quantity').value = '';
        document.getElementById('expiry-date').value = '';
        document.getElementById('description').value = '';
        document.getElementById('custom-medicine-group').style.display = 'none';

        await loadMyMedicines();
    } catch (error) {
        console.error('Error creating medicine:', error);
        showError('create-error', error.message);
    } finally {
        const btn = document.getElementById('btn-create-medicine');
        btn.disabled = false;
        btn.textContent = '🔄 Ustvari Zdravilo';
    }
}

async function sendToDistributor() {
    try {
        clearMessages('delivery');

        const medicineId = document.getElementById('delivery-medicine').value;
        const quantity = parseInt(document.getElementById('delivery-quantity').value, 10);
        const targetDistributor = document.getElementById('target-distributor').value;

        if (!medicineId || !quantity || !targetDistributor) {
            showError('delivery-error', 'Izberite zdravilo, količino in distributorja');
            return;
        }

        const btn = document.getElementById('btn-send-delivery');
        btn.disabled = true;

        const response = await fetch('/api/medicines/add-to-delivery', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: currentSessionId,
                medicineId,
                quantity,
                targetDistributorName: distributorMap[targetDistributor] || '',
                targetDistributorWallet: targetDistributor
            })
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'Napaka pri pošiljanju distributorju');
        }

        showSuccess('delivery-success', `✓ Poslano distributorju ${distributorMap[targetDistributor]}`);
        document.getElementById('delivery-medicine').value = '';
        document.getElementById('delivery-quantity').value = '1';
        document.getElementById('target-distributor').value = '';
        await loadMyMedicines();
    } catch (error) {
        showError('delivery-error', error.message);
    } finally {
        document.getElementById('btn-send-delivery').disabled = false;
    }
}

async function loadMyMedicines() {
    try {
        const response = await fetch(`/api/medicines/my-medicines?sessionId=${encodeURIComponent(currentSessionId)}`);
        if (!response.ok) throw new Error('Napaka pri nalaganju zdravil');

        const data = await response.json();
        medicines = data.medicines || [];
        updateDeliveryMedicineSelect();

        const listDiv = document.getElementById('medicines-list');

        if (medicines.length === 0) {
            listDiv.innerHTML = '<p class="text-muted">Ni še ustvarjenih zdravil...</p>';
            return;
        }

        listDiv.innerHTML = `
            <table>
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>Zdravilo</th>
                        <th>Serijska</th>
                        <th>Skupaj</th>
                        <th>Na zalogi</th>
                        <th>Rok</th>
                        <th>Zaloga / status</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    ${medicines.map(m => `
                        <tr>
                            <td><code class="code-break">${(m.medicine_id || m.medicineId || '').slice(0, 14)}…</code></td>
                            <td>${m.name}</td>
                            <td>${m.batch_number}</td>
                            <td>${m.quantity}</td>
                            <td>${m.available_quantity ?? m.quantity}</td>
                            <td>${m.expiry_date ? formatDisplayDate(m.expiry_date) : '—'}</td>
                            <td>${m.stock_status_label || formatManufacturerStockStatus(m)}</td>
                            <td><button type="button" class="btn btn-sm btn-details" data-medicine-id="${m.medicine_id || m.medicineId}">Pregled</button></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;

        listDiv.querySelectorAll('.btn-details').forEach((btn) => {
            btn.addEventListener('click', async () => {
                try {
                    await openMedicinePreview(btn.dataset.medicineId, currentSessionId);
                } catch (e) {
                    alert(e.message);
                }
            });
        });
    } catch (error) {
        console.error('Error loading medicines:', error);
    }
}

function clearMessages(prefix) {
    if (prefix === 'create' || !prefix) {
        document.getElementById('create-error').style.display = 'none';
        document.getElementById('create-success').style.display = 'none';
    }
    if (prefix === 'delivery' || !prefix) {
        document.getElementById('delivery-error').style.display = 'none';
        document.getElementById('delivery-success').style.display = 'none';
    }
}

function showError(elementId, message) {
    const element = document.getElementById(elementId);
    element.textContent = message;
    element.style.display = 'block';
}

function showSuccess(elementId, message, asHtml = false) {
    const element = document.getElementById(elementId);
    if (asHtml) {
        element.innerHTML = message;
    } else {
        element.textContent = message;
    }
    element.style.display = 'block';
}
