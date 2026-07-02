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
    MANUFACTURED: 'proizvajalec (ob ustvarjanju zdravila)',
    SENT_TO_DISTRIBUTOR: 'proizvajalec (po pošiljanju distributorju)',
    RECEIVED_BY_DISTRIBUTOR: 'distributer (po kliku Sprejmi od proizvajalca)',
    FORWARDED_TO_PHARMACY: 'distributer (po pošiljanju v lekarno)'
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
    revocation,
    stage
}) {
    const reasons = [];

    if (revocation?.revoked) {
        reasons.push(revocation.message || 'Serija zdravila je odvoljena (odpoklic JAZMP)');
    }

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

    const chainPending = Boolean(chainPath?.chainPending);
    const chainBlocked = chainPath?.required && !chainPath.valid && !chainPending;

    if (chainBlocked) {
        reasons.push(chainPath.message || 'Izdelek ni sledil pričakovani poti na blockchainu');
    }

    const credentialOk = reasons.length === 0;

    return {
        allowed: credentialOk && !(chainPath?.required && !chainPath.valid),
        counterfeitAlert: !credentialOk,
        revoked: Boolean(revocation?.revoked),
        chainPending,
        reasons: chainPending
            ? [chainPath.message, ...(chainPath.nextSteps || [])]
            : reasons,
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
            chainPending: false,
            message: 'Blockchain ni konfiguriran — preskočeno'
        };
    }

    try {
        const onChain = await getMedicineFromBlockchain(medicineId);
        if (!onChain?.medicineId) {
            return {
                required: true,
                valid: false,
                chainPending: true,
                missing: ['MANUFACTURED'],
                nextSteps: chainPathNextSteps(['MANUFACTURED']),
                message: 'Zdravilo ni registrirano na blockchainu — preverite deploy pogodbe ali ponovno ustvarite zdravilo (backend avto-registracija)'
            };
        }

        if (ipfsHashFromDb && onChain.ipfsHash && onChain.ipfsHash !== ipfsHashFromDb) {
            return {
                required: true,
                valid: false,
                chainPending: false,
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
                chainPending: true,
                missing,
                events: [...events],
                nextSteps: chainPathNextSteps(missing),
                message: `Manjkajo potrditve na verigi: ${missing.join(', ')}`
            };
        }

        return {
            required: true,
            valid: true,
            chainPending: false,
            events: [...events],
            onChainStatus: onChain.status
        };
    } catch (error) {
        return {
            required: true,
            valid: false,
            chainPending: true,
            nextSteps: ['Preverite povezavo z blockchainom (RPC, CONTRACT_ADDRESS) in MetaMask omrežje'],
            message: `Blockchain ni dosegljiv: ${error.message}`
        };
    }
}
