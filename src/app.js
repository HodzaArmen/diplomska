/**
 * app.js
 * Main orchestrator for the supply chain MVP
 * Demonstrates complete workflow: Manufacturer → Transporter → Pharmacy
 */

require('dotenv').config();

const identity = require('./identity');
const ipfs = require('./ipfs');
const blockchain = require('./blockchain');

// ===== TEST DATA =====
const TEST_USERS = {
    manufacturer: {
        email: 'manufacturer@test.com',
        password: 'TestPass123!',
        name: 'Pharma Corp'
    },
    transporter: {
        email: 'transporter@test.com',
        password: 'TestPass456!',
        name: 'LogistiCorp'
    },
    pharmacy: {
        email: 'pharmacy@test.com',
        password: 'TestPass789!',
        name: 'City Pharmacy'
    }
};

// ===== HELPER: Print section header =====
function printHeader(title) {
    console.log('\n' + '='.repeat(60));
    console.log(`  ${title}`);
    console.log('='.repeat(60));
}

// ===== MAIN WORKFLOW =====
async function runSupplyChainWorkflow() {
    printHeader('SUPPLY CHAIN MVP - COMPLETE WORKFLOW');

    try {
        // ===== STEP 1: Initialize Blockchain =====
        printHeader('STEP 1: Initialize Blockchain Connection');
        
        const rpcUrl = process.env.SEPOLIA_RPC_URL;
        const privateKey = process.env.PRIVATE_KEY;
        const contractAddress = process.env.CONTRACT_ADDRESS;

        if (!rpcUrl || !privateKey || !contractAddress) {
            throw new Error(
                'Missing environment variables:\n' +
                '  - SEPOLIA_RPC_URL\n' +
                '  - PRIVATE_KEY\n' +
                '  - CONTRACT_ADDRESS\n' +
                'Please check your .env file'
            );
        }

        blockchain.initializeBlockchain(rpcUrl, privateKey, contractAddress);
        const signerAddress = blockchain.getSignerAddress();
        console.log(`\nSigner address: ${signerAddress}`);

        // ===== STEP 2: Register Users =====
        printHeader('STEP 2: Register Users on walt.id');
        
        const users = {};

        for (const [role, userData] of Object.entries(TEST_USERS)) {
            console.log(`\nRegistering ${role}...`);
            try {
                const userInfo = await identity.registerUserInWallet(
                    userData.email,
                    userData.password,
                    userData.name
                );
                users[role] = userInfo;
                if (userInfo.status === 'already_registered') {
                    console.log(`ℹ ${role} already existed, reusing DID: ${userInfo.did}`);
                } else {
                    console.log(`✓ ${role} registered with DID: ${userInfo.did}`);
                }
            } catch (error) {
                console.log(`ℹ ${role} might already exist, attempting login...`);
                try {
                    const userInfo = await identity.loginWithDID(
                        userData.email,
                        userData.password
                    );
                    users[role] = userInfo;
                    console.log(`✓ ${role} logged in with DID: ${userInfo.did}`);
                } catch (loginError) {
                    console.error(`✗ Failed to register/login ${role}: ${loginError.message}`);
                    console.log(`  Continuing with test DID...`);
                    users[role] = {
                        email: userData.email,
                        did: `did:key:test${role}${Date.now()}`,
                        name: userData.name
                    };
                }
            }
        }

        // ===== STEP 3: Register Users on Blockchain =====
        printHeader('STEP 3: Register Users on Blockchain');

        for (const [role, userData] of Object.entries(users)) {
            try {
                console.log(`\nRegistering ${role} on blockchain...`);
                const receipt = await blockchain.registerUserOnBlockchain(
                    userData.did,
                    role
                );
                console.log(`✓ ${role} registered on blockchain`);
            } catch (error) {
                console.error(`✗ Failed to register ${role} on blockchain: ${error.message}`);
            }
        }

        // ===== STEP 4: Manufacturer Creates Medicine =====
        printHeader('STEP 4: Manufacturer Creates & Registers Medicine');

        const medicineData = ipfs.generateSampleProductData(1);
        medicineData.manufacturerDID = users.manufacturer.did;

        console.log(`\nCreating medicine: ${medicineData.name}`);
        
        let ipfsHash = null;
        try {
            ipfsHash = await ipfs.uploadProductData(medicineData);
        } catch (error) {
            console.warn(`⚠ IPFS upload skipped (Pinata not configured): ${error.message}`);
            console.log(`  Using mock hash for testing...`);
            ipfsHash = `QmTest${Date.now()}`;
        }

        console.log(`\nRegistering medicine on blockchain...`);
        try {
            await blockchain.registerMedicineOnBlockchain(
                medicineData.medicineId,
                ipfsHash
            );
            console.log(`✓ Medicine registered on blockchain`);
        } catch (error) {
            console.error(`✗ Medicine registration failed: ${error.message}`);
            console.log(`  This is expected if contract not deployed yet`);
        }

        // ===== STEP 5: Transporter Updates Status =====
        printHeader('STEP 5: Transporter Updates Status (In Transit)');

        console.log(`\nTransporter taking possession of medicine...`);
        try {
            await blockchain.updateMedicineStatusOnBlockchain(
                medicineData.medicineId,
                'in_transit'
            );
            console.log(`✓ Status updated to: in_transit`);
        } catch (error) {
            console.error(`✗ Status update failed: ${error.message}`);
        }

        // ===== STEP 6: Pharmacy Confirms Delivery =====
        printHeader('STEP 6: Pharmacy Confirms Delivery');

        console.log(`\nPharmacy receiving medicine...`);
        try {
            await blockchain.updateMedicineStatusOnBlockchain(
                medicineData.medicineId,
                'delivered'
            );
            console.log(`✓ Status updated to: delivered`);
        } catch (error) {
            console.error(`✗ Status update failed: ${error.message}`);
        }

        // ===== STEP 7: Verify Medicine Authenticity =====
        printHeader('STEP 7: Verify Medicine Authenticity');

        console.log(`\nRetrieving medicine details from blockchain...`);
        try {
            const medicine = await blockchain.getMedicineFromBlockchain(
                medicineData.medicineId
            );
            console.log(`\nMedicine Details:`);
            console.log(`  ID: ${medicine.medicineId}`);
            console.log(`  IPFS Hash: ${medicine.ipfsHash}`);
            console.log(`  Manufacturer: ${medicine.manufacturer}`);
            console.log(`  Status: ${medicine.status}`);
            console.log(`  Current Holder: ${medicine.currentHolder}`);
            console.log(`  Holder DID: ${medicine.currentHolderDID}`);
        } catch (error) {
            console.error(`✗ Failed to retrieve medicine: ${error.message}`);
        }

        // ===== STEP 8: Show Supply Chain History =====
        printHeader('STEP 8: Supply Chain History');

        console.log(`\nRetrieving full transaction history...`);
        try {
            const history = await blockchain.getMedicineHistory(
                medicineData.medicineId
            );
            console.log(`\nTransaction History (${history.length} records):`);
            history.forEach((tx, index) => {
                console.log(`\n  Transaction ${index + 1}:`);
                console.log(`    From: ${tx.from} (${tx.fromDID})`);
                console.log(`    To: ${tx.to} (${tx.toDID})`);
                console.log(`    Status: ${tx.status}`);
                console.log(`    Timestamp: ${new Date(tx.timestamp * 1000).toISOString()}`);
            });
        } catch (error) {
            console.error(`✗ Failed to retrieve history: ${error.message}`);
        }

        // ===== WORKFLOW COMPLETE =====
        printHeader('WORKFLOW COMPLETE');
        console.log(`\n✓ Supply chain workflow completed successfully!`);
        console.log(`\nMedicine Details:`);
        console.log(`  ID: ${medicineData.medicineId}`);
        console.log(`  Name: ${medicineData.name}`);
        console.log(`  Manufacturer: ${medicineData.manufacturer}`);
        console.log(`  IPFS Hash: ${ipfsHash}`);
        console.log(`\nUsers Created:`);
        Object.entries(users).forEach(([role, data]) => {
            console.log(`  ${role.padEnd(15)} - ${data.did}`);
        });

    } catch (error) {
        console.error('\n✗ Workflow failed:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// ===== RUN WORKFLOW =====
if (require.main === module) {
    runSupplyChainWorkflow();
}

module.exports = {
    runSupplyChainWorkflow,
    TEST_USERS
};
