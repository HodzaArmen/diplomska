/**
 * supply-chain-truth.js
 * Vir resnice za pregled zdravila: blockchain (Sepolia) + Walt.id Verifier + IPFS.
 * PostgreSQL je le indeks / operativno stanje (inbox), ne prikaz poti dobave.
 */

import crypto from 'crypto';
import { verifyCredentialJwt, decodeVcClaims, resolveHolderCredentialJwt } from './waltid-ssi.js';
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

async function loadUserByWallet(pool, wallet) {
    if (!wallet) return null;
    const r = await pool.query(
        'SELECT * FROM users WHERE LOWER(wallet_address) = LOWER($1)',
        [wallet]
    );
    return r.rows[0] || null;
}

/** VC iz Walt.id walleta imetnika — brez PostgreSQL kopije. */
async function resolveVcFromHolderWallet(pool, holderWallet, filters, expectedIssuerDid, credentialType) {
    const user = await loadUserByWallet(pool, holderWallet);
    if (!user) {
        return {
            verified: false,
            structuralOnly: false,
            jwt: null,
            claims: null,
            message: 'Imetnik VC ni najden',
            source: 'wallet-api'
        };
    }
    try {
        const jwt = await resolveHolderCredentialJwt(user, { credentialType, ...filters });
        if (!jwt) {
            return {
                verified: false,
                structuralOnly: false,
                jwt: null,
                claims: null,
                message: `VC ${credentialType} ni v walletu`,
                source: 'wallet-api'
            };
        }
        return verifyVcRecord(jwt, expectedIssuerDid || user.did, credentialType);
    } catch (error) {
        return {
            verified: false,
            structuralOnly: false,
            jwt: null,
            claims: null,
            message: error.message,
            source: 'wallet-api'
        };
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
        jwt,
        claims: decodeVcClaims(jwt),
        source: 'verifier-api',
        credentialType,
        vcRef: vcJwtReference(jwt)
    };
}

function entityFromWallet(walletMap, address) {
    if (!address || address === '0x0000000000000000000000000000000000000000') {
        return { name: '—', role: null, wallet: address || null, did: null };
    }
    const hit = walletMap.get(String(address).toLowerCase());
    return {
        name: hit?.name || `${String(address).slice(0, 6)}…${String(address).slice(-4)}`,
        role: hit?.role || null,
        wallet: address,
        did: hit?.did || null
    };
}

const JOURNEY_VERBS = {
    MANUFACTURED: 'registriral zdravilo na verigi',
    manufactured: 'registriral zdravilo na verigi',
    SENT_TO_DISTRIBUTOR: 'odposlal k distributorju',
    RECEIVED_BY_DISTRIBUTOR: 'prevzel pošiljko',
    FORWARDED_TO_PHARMACY: 'poslal v lekarno',
    RECEIVED_AT_PHARMACY: 'prevzel v lekarni',
    COUNTERFEIT_ALERT: 'zavrnil prevzem (sum ponareka)'
};

/**
 * Strukturirani koraki poti — vir: blockchain (+ registracija).
 */
export function buildJourneySteps({
    onChainMedicine,
    chainTimeline = [],
    walletMap,
    manufacturerName,
    verifiedDeliveries = []
}) {
    const steps = [];
    let stepNum = 1;

    if (onChainMedicine?.medicineId) {
        const mfg = entityFromWallet(walletMap, onChainMedicine.manufacturer);
        steps.push({
            step: stepNum++,
            action: 'MANUFACTURED',
            actionLabel: CHAIN_EVENT_LABELS.MANUFACTURED,
            verb: JOURNEY_VERBS.MANUFACTURED,
            actor: mfg,
            counterparty: null,
            quantity: null,
            timestamp: onChainMedicine.createdAt
                ? new Date(onChainMedicine.createdAt * 1000).toISOString()
                : null,
            proof: { source: 'blockchain', vcRef: null, ipfs: Boolean(onChainMedicine.ipfsHash) },
            summary: `${mfg.name || manufacturerName || 'Proizvajalec'} je registriral zdravilo na verigi.`
        });
    }

    for (const h of chainTimeline) {
        const isReceive = h.action === 'RECEIVED_BY_DISTRIBUTOR' || h.action === 'RECEIVED_AT_PHARMACY';
        const actorEntity = entityFromWallet(walletMap, isReceive ? h.counterparty : h.actor);
        const counterEntity = entityFromWallet(walletMap, isReceive ? h.actor : h.counterparty);
        const transportVc = verifiedDeliveries.find((d) => d.deliveryId === h.deliveryId);

        let summary;
        if (h.action === 'SENT_TO_DISTRIBUTOR') {
            summary = `${actorEntity.name} je odposlal ${h.quantity || '?'} en k ${counterEntity.name}.`;
        } else if (h.action === 'RECEIVED_BY_DISTRIBUTOR') {
            summary = `${actorEntity.name} je prevzel ${h.quantity || '?'} en od ${counterEntity.name}.`;
        } else if (h.action === 'FORWARDED_TO_PHARMACY') {
            summary = `${actorEntity.name} je poslal ${h.quantity || '?'} en v lekarno ${counterEntity.name}.`;
        } else if (h.action === 'RECEIVED_AT_PHARMACY') {
            summary = `Lekarna ${actorEntity.name} je prevzela ${h.quantity || '?'} en od ${counterEntity.name}.`;
        } else {
            summary = `${actorEntity.name}: ${CHAIN_EVENT_LABELS[h.action] || h.action}`;
        }

        steps.push({
            step: stepNum++,
            action: h.action,
            actionLabel: h.actionLabel || CHAIN_EVENT_LABELS[h.action] || h.action,
            verb: JOURNEY_VERBS[h.action] || h.actionLabel,
            actor: actorEntity,
            counterparty: counterEntity.name !== '—' ? counterEntity : null,
            quantity: h.quantity,
            timestamp: h.timestamp,
            deliveryId: h.deliveryId || null,
            proof: {
                source: 'blockchain',
                vcRef: h.vcRef || null,
                vcVerified: transportVc?.transportVcVerified ?? null,
                ipfs: null
            },
            summary
        });
    }

    return steps;
}

/** Kratka pot npr. "Krka → Distributer X → Lekarna Y" */
export function buildJourneySummary(steps, manufacturerName) {
    const names = [];
    if (manufacturerName) names.push(manufacturerName);
    for (const s of steps) {
        if (s.action === 'SENT_TO_DISTRIBUTOR' && s.counterparty?.name) {
            if (!names.includes(s.counterparty.name)) names.push(s.counterparty.name);
        }
        if (s.action === 'FORWARDED_TO_PHARMACY' && s.counterparty?.name) {
            if (!names.includes(s.counterparty.name)) names.push(s.counterparty.name);
        }
        if (s.action === 'RECEIVED_AT_PHARMACY' && s.actor?.name) {
            if (!names.includes(s.actor.name)) names.push(s.actor.name);
        }
    }
    return names.length ? names.join(' → ') : null;
}

/** Javni (pacientski) pogled — brez wallet/DID/količin. */
export function buildPublicTraceView(verified) {
    const steps = (verified.journeySteps || []).map((s) => ({
        step: s.step,
        actionLabel: s.actionLabel,
        summary: s.summary,
        timestamp: s.timestamp,
        actorName: s.actor?.name || '—',
        actorRole: s.actor?.role || null,
        counterpartyName: s.counterparty?.name || null,
        verified: Boolean(s.proof?.vcRef || s.proof?.source === 'blockchain')
    }));

    return {
        medicineId: verified.medicineId,
        name: verified.name,
        batchNumber: verified.batchNumber,
        expiryDate: verified.expiryDate,
        manufacturerName: verified.manufacturerName,
        journeySummary: verified.journeySummary,
        chainVerified: verified.onChainRegistered && (verified.journeySteps?.length > 0),
        ipfsVerified: Boolean(verified.ipfsVerification?.accessible),
        vcVerified: Boolean(verified.vcSigned),
        trustLevel: verified.trustLevel,
        steps,
        disclaimer: 'Poenostavljen javni pregled porekla. Ne nadomešča uradnega FMD sistema JAZMP.'
    };
}

function computeTrustLevel(verified) {
    const checks = [
        verified.vcSigned,
        verified.ipfsVerification?.accessible,
        verified.onChainRegistered,
        verified.ipfsHashOnChain
    ];
    const passed = checks.filter(Boolean).length;
    if (passed === 4) return 'high';
    if (passed >= 2) return 'mid';
    return 'low';
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

    const ipfsHash = onChainMedicine?.ipfsHash || null;
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

    const medicineVc = await resolveVcFromHolderWallet(
        pool,
        dbMedicine?.manufacturer_wallet,
        { medicineId },
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
        const senderUser = await loadUserByWallet(pool, d.source_wallet);
        const transportVc = await resolveVcFromHolderWallet(
            pool,
            d.source_wallet,
            { medicineId, deliveryId: d.delivery_id },
            senderUser?.did,
            'MedicineTransportCredential'
        );

        verifiedDeliveries.push(
            mergeDeliveryFromChainAndVc(d, chainHandoffs, transportVc)
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

    const journeySteps = buildJourneySteps({
        onChainMedicine,
        chainTimeline,
        walletMap,
        manufacturerName: dbMedicine?.manufacturer_name,
        verifiedDeliveries
    });
    const journeySummary = buildJourneySummary(journeySteps, dbMedicine?.manufacturer_name);

    const baseView = {
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
        medicineVcSource: 'wallet-api',
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
        journeySteps,
        journeySummary,
        deliveries: verifiedDeliveries,
        dataSources: {
            timeline: chainTimeline.length > 0 ? 'blockchain' : 'none',
            medicineVc: medicineVc.jwt ? 'wallet-api' : 'none',
            transportVc: 'wallet-api',
            productData: ipfsHashOnChain ? 'ipfs-via-blockchain' : (ipfsHash ? 'ipfs-index' : 'none'),
            deliveriesIndex: 'postgres-inbox-only',
            vcSource: 'wallet-api-only',
            operationalNote: 'VC se bere iz Walt.id walleta imetnika. PostgreSQL ne hrani JWT kopij.',
            note: chainTimeline.length === 0
                ? 'Na verigi še ni handoff dogodkov. Po redeploy pogodbe in novih pošiljkah bo pot dobave prišla iz blockchaina.'
                : 'Pot dobave in statusi iz blockchaina; VC preverjeni prek Walt.id Verifier API (tutorial OID4VP).',
            chainNetwork: process.env.CHAIN_NAME || 'Sepolia'
        }
    };
    baseView.trustLevel = computeTrustLevel(baseView);
    return baseView;
}
