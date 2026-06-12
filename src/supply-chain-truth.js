/**
 * supply-chain-truth.js
 * Vir resnice za pregled zdravila: blockchain (Sepolia) + Walt.id Verifier + IPFS.
 * PostgreSQL je le indeks / operativno stanje (inbox), ne prikaz poti dobave.
 */

import crypto from 'crypto';
import { verifyCredentialJwt, decodeVcClaims } from './waltid-ssi.js';
import { fetchIpfsJson, verifyIpfsAccessible } from './ipfs.js';
import {
    getMedicineFromBlockchain,
    getMedicineHandoffsFromBlockchain
} from './blockchain.js';

export const CHAIN_EVENT_LABELS = {
    COUNTERFEIT_ALERT: 'Opozorilo: možen ponaredek (prevzem zavrnjen)',
    PARTNER_REPUTATION: 'Ocena partnerja po prevzemu',
    MANUFACTURED: 'Registrirano na verigi',
    manufactured: 'Registrirano na verigi',
    SENT_TO_DISTRIBUTOR: 'Odpremljeno k distributorju',
    RECEIVED_BY_DISTRIBUTOR: 'Prevzeto pri distributorju',
    FORWARDED_TO_PHARMACY: 'Odpremljeno v lekarno',
    RECEIVED_AT_PHARMACY: 'Prevzeto v lekarni',
    in_transit: 'V dostavi',
    delivered: 'Dostavljeno'
};

const DELIVERY_STATUS_FROM_EVENT = {
    SENT_TO_DISTRIBUTOR: 'PENDING',
    RECEIVED_BY_DISTRIBUTOR: 'RECEIVED',
    FORWARDED_TO_PHARMACY: 'IN_TRANSIT',
    RECEIVED_AT_PHARMACY: 'DELIVERED'
};

export function vcJwtReference(jwt) {
    if (!jwt || typeof jwt !== 'string') return '';
    return crypto.createHash('sha256').update(jwt).digest('hex').slice(0, 32);
}

export function parseStoredVcRecord(vcRaw) {
    if (!vcRaw) return { signed: false, jwt: null, claims: null, error: null };
    try {
        const parsed = typeof vcRaw === 'string' ? JSON.parse(vcRaw) : vcRaw;
        const jwt = parsed.signedJwt || parsed.jwt
            || (typeof parsed === 'string' && parsed.includes('.') ? parsed : null);
        return {
            signed: Boolean(jwt || parsed.signed === true),
            jwt,
            claims: jwt ? decodeVcClaims(jwt) : null,
            error: parsed.error || null
        };
    } catch {
        if (typeof vcRaw === 'string' && vcRaw.includes('.')) {
            return { signed: true, jwt: vcRaw, claims: decodeVcClaims(vcRaw), error: null };
        }
        return { signed: false, jwt: null, claims: null, error: null };
    }
}

async function loadWalletLabelMap(pool, wallets = []) {
    const unique = [...new Set(wallets.filter(Boolean).map((w) => w.toLowerCase()))];
    const map = new Map();
    if (unique.length === 0) return map;

    const result = await pool.query(
        `SELECT wallet_address, company_name, role, did
         FROM users WHERE LOWER(wallet_address) = ANY($1::text[])`,
        [unique]
    );
    for (const row of result.rows) {
        map.set(row.wallet_address.toLowerCase(), {
            name: row.company_name,
            role: row.role,
            did: row.did
        });
    }
    return map;
}

function walletLabel(map, address) {
    if (!address || address === '0x0000000000000000000000000000000000000000') return '—';
    const hit = map.get(String(address).toLowerCase());
    return hit ? `${hit.name} (${hit.role})` : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

async function verifyVcRecord(jwt, expectedIssuerDid, credentialType) {
    if (!jwt) {
        return {
            verified: false,
            claims: null,
            message: 'VC ni na voljo',
            source: 'verifier-api',
            structuralOnly: false
        };
    }
    const result = await verifyCredentialJwt(jwt, expectedIssuerDid);
    return {
        ...result,
        claims: decodeVcClaims(jwt),
        source: 'verifier-api',
        credentialType,
        vcRef: vcJwtReference(jwt)
    };
}

function chainHandoffToTimelineEvent(h, walletMap, deliveryQtyMap = null) {
    const isReceive = h.eventType === 'RECEIVED_BY_DISTRIBUTOR' || h.eventType === 'RECEIVED_AT_PHARMACY';
    let quantity = h.quantity || null;
    if (h.deliveryId && deliveryQtyMap?.has(h.deliveryId)) {
        quantity = deliveryQtyMap.get(h.deliveryId);
    }
    const actor = isReceive ? h.counterparty : h.actor;
    const counterparty = isReceive ? h.actor : h.counterparty;
    const actorDID = isReceive ? h.counterpartyDID : h.actorDID;
    const counterpartyDID = isReceive ? h.actorDID : h.counterpartyDID;

    return {
        action: h.eventType,
        actionLabel: CHAIN_EVENT_LABELS[h.eventType] || h.eventType,
        actor,
        actorLabel: walletLabel(walletMap, actor),
        actorDID,
        counterparty,
        counterpartyLabel: walletLabel(walletMap, counterparty),
        counterpartyDID,
        deliveryId: h.deliveryId || null,
        quantity,
        timestamp: h.timestamp ? new Date(h.timestamp * 1000).toISOString() : null,
        vcRef: h.vcRef || null,
        source: 'blockchain'
    };
}

function mergeDeliveryFromChainAndVc(dbRow, chainEvents, verifiedTransport) {
    const chainForDelivery = chainEvents.filter((e) => e.deliveryId === dbRow.delivery_id);
    const sendEvent = chainForDelivery.find((e) =>
        e.eventType === 'SENT_TO_DISTRIBUTOR' || e.eventType === 'FORWARDED_TO_PHARMACY'
    );
    const recvEvent = chainForDelivery.find((e) =>
        e.eventType === 'RECEIVED_BY_DISTRIBUTOR' || e.eventType === 'RECEIVED_AT_PHARMACY'
    );

    const status = recvEvent
        ? (DELIVERY_STATUS_FROM_EVENT[recvEvent.eventType] || dbRow.status)
        : (sendEvent ? (DELIVERY_STATUS_FROM_EVENT[sendEvent.eventType] || dbRow.status) : dbRow.status);

    return {
        deliveryId: dbRow.delivery_id,
        quantity: sendEvent?.quantity || dbRow.quantity,
        status,
        sourceRole: dbRow.source_role,
        sourceName: dbRow.source_name,
        sourceWallet: dbRow.source_wallet,
        targetRole: dbRow.target_role,
        targetName: dbRow.target_pharmacy_name || dbRow.target_name,
        targetWallet: dbRow.target_wallet,
        createdAt: sendEvent?.timestamp || dbRow.created_at,
        receivedAt: recvEvent?.timestamp || dbRow.received_at,
        onChain: chainForDelivery.length > 0,
        chainVcRef: sendEvent?.vcRef || recvEvent?.vcRef || null,
        transportVcVerified: verifiedTransport?.verified ?? false,
        transportVcStructuralOnly: verifiedTransport?.structuralOnly ?? false,
        transportVcMessage: verifiedTransport?.message || null,
        transportVcSigned: Boolean(verifiedTransport?.verified || verifiedTransport?.claims),
        transportVcClaims: verifiedTransport?.claims || null,
        transportVcSource: 'verifier-api'
    };
}

/**
 * Zgradi pogled zdravila iz blockchain + verifier + IPFS.
 * @param {object} opts
 * @param {string} opts.medicineId
 * @param {object} opts.dbMedicine — minimalni indeks iz PostgreSQL
 * @param {Array} opts.dbDeliveries — za korelacijo delivery ID + JWT za verifier
 * @param {object} opts.pool — DB samo za imena podjetij (DID registry)
 * @param {boolean} opts.blockchainReady
 * @param {string|null} opts.viewerRole
 * @param {string|null} opts.viewerWallet
 * @param {string|null} opts.deliveryId
 */
export async function buildVerifiedMedicineView({
    medicineId,
    dbMedicine,
    dbDeliveries = [],
    pool,
    blockchainReady,
    viewerRole = null,
    viewerWallet = null,
    deliveryId = null
}) {
    let onChainMedicine = null;
    let chainHandoffs = [];
    let chainError = null;

    if (blockchainReady) {
        try {
            onChainMedicine = await getMedicineFromBlockchain(medicineId);
            chainHandoffs = await getMedicineHandoffsFromBlockchain(medicineId);
        } catch (error) {
            chainError = error.message;
        }
    }

    const ipfsHash = onChainMedicine?.ipfsHash || dbMedicine?.ipfs_hash || null;
    const ipfsHashOnChain = Boolean(onChainMedicine?.ipfsHash);
    const ipfsHashMatchesDb = !onChainMedicine?.ipfsHash
        || !dbMedicine?.ipfs_hash
        || onChainMedicine.ipfsHash === dbMedicine.ipfs_hash;

    let ipfsPreview = null;
    let ipfsVerification = { accessible: false, message: 'IPFS hash ni na verigi' };
    if (ipfsHash) {
        try {
            ipfsPreview = await fetchIpfsJson(ipfsHash);
            ipfsVerification = await verifyIpfsAccessible(ipfsHash);
            ipfsVerification.source = 'ipfs-gateway';
        } catch (error) {
            ipfsVerification = { accessible: false, message: error.message, source: 'ipfs-gateway' };
        }
    }

    const medicineVcRaw = parseStoredVcRecord(dbMedicine?.vc_credential);
    const medicineVc = await verifyVcRecord(
        medicineVcRaw.jwt,
        dbMedicine?.manufacturer_did,
        'MedicineCredential'
    );

    const walletsToResolve = [
        dbMedicine?.manufacturer_wallet,
        onChainMedicine?.manufacturer,
        onChainMedicine?.currentHolder,
        ...chainHandoffs.flatMap((h) => [h.actor, h.counterparty]),
        ...dbDeliveries.flatMap((d) => [d.source_wallet, d.target_wallet])
    ];
    const walletMap = await loadWalletLabelMap(pool, walletsToResolve);

    const deliveryQtyMap = new Map(
        dbDeliveries
            .filter((d) => d.delivery_id && d.quantity != null)
            .map((d) => [d.delivery_id, Number(d.quantity)])
    );
    const chainTimeline = chainHandoffs.map((h) => chainHandoffToTimelineEvent(h, walletMap, deliveryQtyMap));

    const verifiedDeliveries = [];
    for (const d of dbDeliveries) {
        const vc = parseStoredVcRecord(d.transport_vc_credential);
        const expectedDid = d.source_role === 'manufacturer'
            ? dbMedicine?.manufacturer_did
            : (await pool.query(
                'SELECT did FROM users WHERE wallet_address = $1',
                [d.source_wallet]
            )).rows[0]?.did;

        const verifiedTransport = vc.jwt
            ? await verifyVcRecord(vc.jwt, expectedDid, 'MedicineTransportCredential')
            : { verified: false, claims: null, message: 'Transport VC ni izdan', source: 'verifier-api' };

        verifiedDeliveries.push(
            mergeDeliveryFromChainAndVc(d, chainHandoffs, verifiedTransport)
        );
    }

    let receivedQuantity = dbMedicine?.quantity ?? 0;
    if (viewerRole === 'pharmacy' && viewerWallet) {
        if (deliveryId) {
            const d = verifiedDeliveries.find((x) => x.deliveryId === deliveryId);
            receivedQuantity = d?.quantity ?? 0;
        } else {
            receivedQuantity = verifiedDeliveries
                .filter((d) => d.targetWallet === viewerWallet && d.status === 'DELIVERED')
                .reduce((sum, d) => sum + (d.quantity || 0), 0);
        }
    }

    const name = ipfsPreview?.name || dbMedicine?.name;
    const batchNumber = ipfsPreview?.batchNumber || dbMedicine?.batch_number;
    const expiryDate = ipfsPreview?.expiryDate || dbMedicine?.expiry_date;

    const availableMfg = (dbMedicine?.quantity ?? 0) - dbDeliveries
        .filter((d) => d.source_role === 'manufacturer')
        .reduce((s, d) => s + (d.quantity || 0), 0);
    const pendingQty = verifiedDeliveries.filter((d) => d.status === 'PENDING').reduce((s, d) => s + d.quantity, 0);
    const receivedAtDist = dbDeliveries
        .filter((d) => d.source_role === 'manufacturer' && d.status === 'RECEIVED')
        .reduce((s, d) => s + (d.quantity || 0), 0);
    const forwardedFromDist = dbDeliveries
        .filter((d) => d.source_role === 'distributor' && ['IN_TRANSIT', 'DELIVERED'].includes(d.status))
        .reduce((s, d) => s + (d.quantity || 0), 0);
    const atDistQty = Math.max(0, receivedAtDist - forwardedFromDist);
    const inTransitPharmacy = verifiedDeliveries
        .filter((d) => d.sourceRole === 'distributor' && d.status === 'IN_TRANSIT')
        .reduce((s, d) => s + d.quantity, 0);
    const deliveredPharmacy = verifiedDeliveries
        .filter((d) => d.sourceRole === 'distributor' && d.status === 'DELIVERED')
        .reduce((s, d) => s + d.quantity, 0);
    const stockParts = [];
    if (availableMfg > 0) stockParts.push(`${availableMfg} na zalogi`);
    if (pendingQty > 0) stockParts.push(`${pendingQty} čaka prevzem`);
    if (atDistQty > 0) stockParts.push(`${atDistQty} pri distributorju`);
    if (inTransitPharmacy > 0) stockParts.push(`${inTransitPharmacy} v dostavi v lekarno`);
    if (deliveredPharmacy > 0) stockParts.push(`${deliveredPharmacy} v lekarni`);

    const chainStatus = onChainMedicine?.status || null;
    const currentHolderLabel = walletLabel(walletMap, onChainMedicine?.currentHolder);

    return {
        medicineId,
        name,
        batchNumber,
        stockStatusLabel: stockParts.length ? stockParts.join(' · ') : null,
        totalManufacturedQuantity: dbMedicine?.quantity,
        receivedQuantity,
        quantity: viewerRole === 'pharmacy' ? receivedQuantity : dbMedicine?.quantity,
        expiryDate,
        manufacturerName: dbMedicine?.manufacturer_name,
        manufacturerWallet: dbMedicine?.manufacturer_wallet,
        manufacturerDID: dbMedicine?.manufacturer_did,
        description: ipfsPreview?.description || dbMedicine?.description,
        blockchainStatus: chainStatus || dbMedicine?.blockchain_status,
        txHash: dbMedicine?.blockchain_tx_hash,
        ipfsHash,
        ipfsPreview,
        ipfsVerification,
        ipfsHashOnChain,
        ipfsHashMatchesDb,
        vcSigned: medicineVc.verified,
        vcStructuralOnly: medicineVc.structuralOnly,
        vcVerificationMessage: medicineVc.message,
        medicineVcClaims: medicineVc.claims,
        medicineVcSource: 'verifier-api',
        onChainRegistered: Boolean(onChainMedicine?.medicineId),
        onChain: {
            available: Boolean(onChainMedicine),
            medicine: onChainMedicine,
            handoffs: chainHandoffs,
            error: chainError,
            currentHolderLabel,
            currentHolderDID: onChainMedicine?.currentHolderDID || null
        },
        supplyChainHistory: chainTimeline,
        deliveries: verifiedDeliveries,
        dataSources: {
            timeline: chainTimeline.length > 0 ? 'blockchain' : 'none',
            medicineVc: medicineVc.jwt ? 'verifier-api' : 'none',
            transportVc: 'verifier-api',
            productData: ipfsHashOnChain ? 'ipfs-via-blockchain' : (ipfsHash ? 'ipfs-index' : 'none'),
            deliveriesIndex: 'postgres-inbox-only',
            note: chainTimeline.length === 0
                ? 'Na verigi še ni handoff dogodkov. Po redeploy pogodbe in novih pošiljkah bo pot dobave prišla iz blockchaina.'
                : 'Pot dobave in statusi iz blockchaina; VC preverjeni prek Walt.id Verifier API (tutorial OID4VP).',
            chainNetwork: process.env.CHAIN_NAME || 'Sepolia'
        }
    };
}
