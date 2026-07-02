/**
 * send-shipment.js — skupna logika pošiljanja z rollback ob preklicu MetaMask
 */

async function cancelPendingDelivery(sessionId, deliveryId) {
    if (!sessionId || !deliveryId) return { ok: false };
    try {
        const res = await fetch('/api/deliveries/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, deliveryId })
        });
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok, ...data };
    } catch (error) {
        console.warn('Preklic pošiljke:', error.message);
        return { ok: false, error: error.message };
    }
}

async function executeShipmentWithBlockchain({
    sessionId,
    apiUrl,
    body,
    chainHistoryAction,
    onProgress
}) {
    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const raw = await response.text();
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        throw new Error(raw.includes('Too many') ? 'Preveč zahtev — počakajte in poskusite znova' : raw.slice(0, 200));
    }
        if (!response.ok) {
            if (response.status === 410 && data.revoked) {
                throw new Error(data.error || 'Serija je odpoklicana — pošiljanje ni dovoljeno');
            }
            throw new Error(data.error || 'Napaka pri pošiljanju');
        }

    const deliveryId = data.delivery?.deliveryId || data.delivery?.delivery_id;

    if (data.chainHandoff?.autoSigned) {
        return data;
    }

    try {
        if (data.chainHandoff?.needsBlockchain && window.BlockchainMetaMask) {
            onProgress?.('⏳ MetaMask...');
            const chainResult = await BlockchainMetaMask.signHandoffAndConfirm(
                sessionId,
                data.chainHandoff,
                chainHistoryAction
            );
            if (!chainResult?.txHash) {
                throw new Error(`MetaMask handoff ${chainHistoryAction} ni potrjen.`);
            }
        } else if (data.chainHandoff?.needsBlockchain) {
            throw new Error(`Potrdite ${chainHistoryAction} v MetaMask.`);
        }
    } catch (chainErr) {
        if (deliveryId) {
            await cancelPendingDelivery(sessionId, deliveryId);
        }
        throw chainErr;
    }

    return data;
}

function updateShipmentMedicineSelect(selectEl, medicines, opts = {}) {
    if (!selectEl) return;
    const idKey = opts.idKey || 'medicine_id';
    const availKey = opts.availKey || 'available_quantity';
    const placeholder = opts.placeholder || '— Izberite zdravilo —';
    const preserveValue = opts.preserveValue ? selectEl.value : '';

    if (selectEl.options.length === 0) {
        const ph = document.createElement('option');
        ph.value = '';
        ph.textContent = placeholder;
        selectEl.appendChild(ph);
    } else if (selectEl.options[0]) {
        selectEl.options[0].textContent = placeholder;
    }

    while (selectEl.options.length > 1) {
        selectEl.remove(1);
    }

    medicines
        .filter((m) => {
            if (typeof isMedicineRevoked === 'function' && isMedicineRevoked(m)) return false;
            const available = parseInt(m[availKey] ?? m.quantity ?? 0, 10);
            return available > 0;
        })
        .forEach((m) => {
            const medicineId = m[idKey] || m.medicineId;
            const available = parseInt(m[availKey] ?? m.quantity ?? 0, 10);
            const option = document.createElement('option');
            option.value = medicineId;
            option.textContent = `${m.name} (${medicineId}) — ${available} na voljo`;
            option.dataset.maxQuantity = String(available);
            selectEl.appendChild(option);
        });

    if (selectEl.options.length === 1) {
        const empty = document.createElement('option');
        empty.value = '';
        empty.disabled = true;
        empty.textContent = 'Ni zaloge za pošiljanje';
        selectEl.appendChild(empty);
    } else if (selectEl.options[0]) {
        selectEl.options[0].textContent = placeholder;
    }

    if (preserveValue) {
        const hasOption = [...selectEl.options].some((o) => o.value === preserveValue);
        if (hasOption) selectEl.value = preserveValue;
    }
}

function readShipmentMaxQuantity(selectEl) {
    const opt = selectEl?.selectedOptions?.[0];
    return parseInt(opt?.dataset?.maxQuantity ?? '0', 10);
}

function clampShipmentQuantityInput(quantityInput, maxQty) {
    if (!quantityInput || maxQty <= 0) return;
    quantityInput.max = String(maxQty);
    const current = parseInt(quantityInput.value, 10);
    if (!current || current > maxQty) {
        quantityInput.value = String(Math.min(maxQty, 1));
    }
}

function getAvailableFromList(medicines, medicineId, opts = {}) {
    const idKey = opts.idKey || 'medicine_id';
    const availKey = opts.availKey || 'available_quantity';
    const med = (medicines || []).find(
        (m) => (m[idKey] || m.medicineId) === medicineId
    );
    return parseInt(med?.[availKey] ?? 0, 10);
}
