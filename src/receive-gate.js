/**
 * receive-gate.js
 * Fail-closed preverjanje ob prevzemu (članek: counterfeit alert + tutorial: OID4VP).
 * Prevzem se zavrne, če VC/IPFS/veriga ne ustrezajo — ne samo opozorilo.
 */

import {
    getMedicineFromBlockchain,
    getMedicineHandoffsFromBlockchain,
    getMedicineHistory
} from './blockchain.js';

const CHAIN_STEPS = {
    distributor: ['SENT_TO_DISTRIBUTOR'],
    pharmacy: ['SENT_TO_DISTRIBUTOR', 'RECEIVED_BY_DISTRIBUTOR', 'FORWARDED_TO_PHARMACY']
};

/** Kdo mora potrditi handoff v MetaMask (msg.sender) */
export const CHAIN_STEP_ACTOR = {
    SENT_TO_DISTRIBUTOR: 'proizvajalec (po pošiljanju distributorju)',
    RECEIVED_BY_DISTRIBUTOR: 'distributer (po kliku Sprejmi od proizvajalca)',
    FORWARDED_TO_PHARMACY: 'distributer (po pošiljanju v lekarno)',
    FORWARDED_TO_PHARMACY_alt: 'distributer (po pošiljanju v lekarno)'
};

export function chainPathNextSteps(missing = []) {
    return missing.map((step) => {
        const who = CHAIN_STEP_ACTOR[step] || 'udeleženec';
        return `Potrdite ${step} v MetaMask — ${who}`;
    });
}

export function isStrictVerificationOk(vcResult) {
    if (!vcResult) return false;
    if (vcResult.structuralOnly) return false;
    return vcResult.verified === true;
}

export function buildReceiveGateResult({
    medicineVc,
    transportVc,
    ipfs,
    chainPath,
    stage
}) {
    const reasons = [];

    if (!isStrictVerificationOk(medicineVc)) {
        reasons.push(
            medicineVc?.structuralOnly
                ? 'VC zdravila ni kriptografsko preverjen (strukturni fallback zavrnjen)'
                : (medicineVc?.message || 'VC zdravila ni veljaven')
        );
    }
    if (!isStrictVerificationOk(transportVc)) {
        reasons.push(
            transportVc?.structuralOnly
                ? 'VC pošiljke ni kriptografsko preverjen (strukturni fallback zavrnjen)'
                : (transportVc?.message || 'VC pošiljke ni veljaven')
        );
    }
    if (!ipfs?.accessible) {
        reasons.push(ipfs?.message || 'IPFS metapodatki niso dostopni');
    }
    if (chainPath?.required && !chainPath.valid) {
        reasons.push(chainPath.message || 'Izdelek ni sledil pričakovani poti na blockchainu');
    }

    return {
        allowed: reasons.length === 0,
        counterfeitAlert: reasons.length > 0,
        reasons,
        stage
    };
}

export async function validateChainPathForReceive({
    medicineId,
    deliveryId,
    stage,
    blockchainReady,
    ipfsHashFromDb
}) {
    if (!blockchainReady) {
        return {
            required: false,
            valid: true,
            skipped: true,
            message: 'Blockchain ni konfiguriran — preskočeno'
        };
    }

    try {
        const onChain = await getMedicineFromBlockchain(medicineId);
        if (!onChain?.medicineId) {
            return {
                required: true,
                valid: false,
                message: 'Zdravilo ni registrirano na blockchainu (MANUFACTURED)'
            };
        }

        if (ipfsHashFromDb && onChain.ipfsHash && onChain.ipfsHash !== ipfsHashFromDb) {
            return {
                required: true,
                valid: false,
                message: 'IPFS hash v bazi se ne ujema s hashom na verigi'
            };
        }

        const handoffs = await getMedicineHandoffsFromBlockchain(medicineId);
        let history = [];
        try {
            history = await getMedicineHistory(medicineId);
        } catch {
            history = [];
        }

        const chainEvents = [
            ...handoffs.map((h) => ({
                eventType: h.eventType,
                deliveryId: h.deliveryId || ''
            })),
            ...history.map((h) => ({
                eventType: h.status,
                deliveryId: ''
            }))
        ];

        const forDelivery = chainEvents.filter(
            (h) => !h.deliveryId || h.deliveryId === deliveryId
        );
        const events = new Set(forDelivery.map((h) => h.eventType));

        const required = CHAIN_STEPS[stage] || [];
        const missing = required.filter((step) => !events.has(step));

        if (missing.length > 0) {
            return {
                required: true,
                valid: false,
                missing,
                events: [...events],
                nextSteps: chainPathNextSteps(missing),
                message: `Manjkajoči dogodki na verigi za ${deliveryId}: ${missing.join(', ')}`
            };
        }

        return {
            required: true,
            valid: true,
            events: [...events],
            onChainStatus: onChain.status
        };
    } catch (error) {
        return {
            required: true,
            valid: false,
            message: `Preverjanje verige ni uspelo: ${error.message}`
        };
    }
}
