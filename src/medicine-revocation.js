/**
 * medicine-revocation.js — odpoklic serije zdravila (JAZMP / regulator)
 *
 * Tri plasti:
 *   1) PostgreSQL — takojšnja blokada prevzema in pošiljanja
 *   2) Blockchain — nespremenljiv REVOKED status + zgodovina
 *   3) credential_revocations — register VC id (jti) za audit
 */

import { getMedicineFromBlockchain } from './blockchain.js';

export const MEDICINE_REVOKED_STATUS = 'REVOKED';

export function isMedicineRevokedInDb(medicineRow) {
    if (!medicineRow) return false;
    return medicineRow.is_active === false
        || medicineRow.blockchain_status === MEDICINE_REVOKED_STATUS
        || Boolean(medicineRow.revoked_at);
}

export function isMedicineRevokedOnChain(onChainMedicine) {
    return String(onChainMedicine?.status || '').toUpperCase() === MEDICINE_REVOKED_STATUS;
}

/**
 * @returns {Promise<{ revoked, dbRevoked, onChainRevoked, reason, revokedAt, revokedBy, txHash, source, message? }>}
 */
export async function getMedicineRevocationStatus(pool, medicineId, blockchainReady = false) {
    const result = await pool.query(
        `SELECT medicine_id, is_active, blockchain_status, revoked_at, revoked_by,
                revocation_reason, revocation_tx_hash, vc_credential_id
         FROM medicines WHERE medicine_id = $1`,
        [medicineId]
    );
    const row = result.rows[0];
    if (!row) {
        return { revoked: false, notFound: true };
    }

    const dbRevoked = isMedicineRevokedInDb(row);
    let onChainRevoked = false;
    let onChainStatus = null;

    if (blockchainReady) {
        try {
            const onChain = await getMedicineFromBlockchain(medicineId);
            onChainStatus = onChain?.status || null;
            onChainRevoked = isMedicineRevokedOnChain(onChain);
        } catch {
            // veriga nedosegljiva — zanašamo se na DB
        }
    }

    const revoked = dbRevoked || onChainRevoked;

    return {
        revoked,
        dbRevoked,
        onChainRevoked,
        onChainStatus,
        reason: row.revocation_reason || null,
        revokedAt: row.revoked_at || null,
        revokedBy: row.revoked_by || null,
        txHash: row.revocation_tx_hash || null,
        vcCredentialId: row.vc_credential_id || null,
        medicineId,
        source: dbRevoked && onChainRevoked
            ? 'db+chain'
            : (dbRevoked ? 'db' : (onChainRevoked ? 'chain' : null)),
        message: revoked
            ? `Serija ${medicineId} je odvoljena${row.revocation_reason ? `: ${row.revocation_reason}` : ''}`
            : null
    };
}

export function buildRevocationFailure(vcLabel, revocation) {
    const detail = revocation?.reason ? ` Razlog: ${revocation.reason}` : '';
    return {
        verified: false,
        structuralOnly: false,
        revoked: true,
        message: `${vcLabel} — zdravilo je odvoljeno (odpoklic serije).${detail}`,
        revocation
    };
}

/**
 * Zapiše odpoklic v DB, prekliče odprte pošiljke, zabeleži revokirane VC.
 */
export async function applyMedicineRevocation(pool, {
    medicineId,
    revokedBy,
    reason,
    revocationTxHash = null,
    credentialIds = []
}) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(
            `UPDATE medicines
             SET is_active = FALSE,
                 blockchain_status = $1,
                 revoked_at = CURRENT_TIMESTAMP,
                 revoked_by = $2,
                 revocation_reason = $3,
                 revocation_tx_hash = COALESCE($4, revocation_tx_hash)
             WHERE medicine_id = $5`,
            [MEDICINE_REVOKED_STATUS, revokedBy, reason, revocationTxHash, medicineId]
        );

        await client.query(
            `UPDATE deliveries
             SET status = 'CANCELLED'
             WHERE medicine_id = $1 AND status IN ('PENDING', 'IN_TRANSIT')`,
            [medicineId]
        );

        const uniqueCredentialIds = [...new Set(credentialIds.filter(Boolean))];
        for (const credentialId of uniqueCredentialIds) {
            await client.query(
                `INSERT INTO credential_revocations
                 (medicine_id, credential_id, credential_type, revoked_by, reason, revocation_tx_hash)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (medicine_id, credential_id) DO NOTHING`,
                [medicineId, credentialId, 'MedicineCredential', revokedBy, reason, revocationTxHash]
            );
        }

        await client.query(
            `INSERT INTO supply_chain_history
             (medicine_id, action, actor_wallet, actor_role, details, blockchain_tx_hash)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                medicineId,
                'REVOKED',
                revokedBy,
                'regulator',
                JSON.stringify({ reason, credentialIds: uniqueCredentialIds }),
                revocationTxHash
            ]
        );

        await client.query('COMMIT');
        return { ok: true };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

export async function isCredentialRevoked(pool, { medicineId, credentialId }) {
    if (!medicineId && !credentialId) return false;

    if (medicineId) {
        const med = await pool.query(
            'SELECT is_active, revoked_at, blockchain_status FROM medicines WHERE medicine_id = $1',
            [medicineId]
        );
        if (isMedicineRevokedInDb(med.rows[0])) return true;
    }

    if (credentialId) {
        const cred = await pool.query(
            'SELECT 1 FROM credential_revocations WHERE credential_id = $1 LIMIT 1',
            [credentialId]
        );
        if (cred.rows.length > 0) return true;
    }

    return false;
}
