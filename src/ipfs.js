/**
 * ipfs.js
 * Integration with Pinata for storing product data on IPFS
 */

import axios from 'axios';

// Pinata API endpoint
export const PINATA_API_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';

// ===== FUNCTION: Upload product data to IPFS =====
/**
 * Uploads product/medicine data as JSON to Pinata IPFS
 * @param {Object} productData - Product data object
 * @param {string} productData.medicineId - Unique medicine ID
 * @param {string} productData.name - Medicine name
 * @param {string} productData.serialNumber - Serial number
 * @param {string} productData.manufacturerDID - Manufacturer's DID
 * @param {string} productData.batchNumber - Batch/lot number
 * @param {string} productData.expiryDate - Expiry date (YYYY-MM-DD)
 * @param {string} productData.manufacturer - Manufacturer name
 * @returns {Promise<string>} - Returns IPFS CID hash
 */
async function uploadProductData(productData) {
    const apiKey = process.env.PINATA_API_KEY;
    const secretKey = process.env.PINATA_SECRET_API_KEY;

    if (!apiKey || !secretKey) {
        throw new Error('Missing PINATA_API_KEY or PINATA_SECRET_API_KEY in environment variables');
    }

    try {
        console.log(`\n[IPFS] Uploading product data to Pinata...`);
        console.log(`  Medicine: ${productData.medicineId}`);
        console.log(`  Name: ${productData.name}`);

        // Prepare the data with metadata
        const dataToUpload = {
            ...productData,
            uploadedAt: new Date().toISOString(),
            version: '1.0'
        };

        // Make request to Pinata
        const response = await axios.post(PINATA_API_URL, dataToUpload, {
            headers: {
                'pinata_api_key': apiKey,
                'pinata_secret_api_key': secretKey,
                'Content-Type': 'application/json'
            }
        });

        const ipfsHash = response.data.IpfsHash;
        console.log(`✓ Data uploaded to IPFS`);
        console.log(`  CID: ${ipfsHash}`);

        return ipfsHash;

    } catch (error) {
        console.error(`✗ Pinata upload failed: ${error.message}`);
        if (error.response) {
            console.error(`Response status: ${error.response.status}`);
            console.error(`Response data:`, error.response.data);
        }
        throw error;
    }
}

// ===== FUNCTION: Create product data object =====
/**
 * Helper to create a properly formatted product data object
 * @param {Object} medicineInfo - Medicine information
 * @returns {Object} - Formatted product data
 */
function createProductData(medicineInfo) {
    return {
        medicineId: medicineInfo.medicineId || 'MED-' + Date.now(),
        name: medicineInfo.name || 'Unknown Medicine',
        serialNumber: medicineInfo.serialNumber || 'SN-' + Math.random().toString(36).substr(2, 9),
        manufacturerDID: medicineInfo.manufacturerDID || 'did:unknown',
        manufacturer: medicineInfo.manufacturer || 'Unknown Manufacturer',
        batchNumber: medicineInfo.batchNumber || 'BATCH-' + Date.now(),
        expiryDate: medicineInfo.expiryDate || new Date(Date.now() + 365*24*60*60*1000).toISOString().split('T')[0],
        quantity: medicineInfo.quantity || 1,
        description: medicineInfo.description || '',
        origin: medicineInfo.origin || 'Unknown Origin'
    };
}

// ToDo: Remove it after testing
// ===== FUNCTION: Generate sample product data =====
/**
 * Generate sample medicine data for testing
 * @param {number} index - Product index for generating unique data
 * @returns {Object} - Sample product data
 */
function generateSampleProductData(index = 1) {
    const medicines = [
        { name: 'Aspirin', manufacturer: 'Pharma Corp' },
        { name: 'Antibiotics', manufacturer: 'HealthCare Inc' },
        { name: 'Vitamins', manufacturer: 'Wellness Ltd' }
    ];

    const med = medicines[index % medicines.length];
    const timestamp = Date.now();

    return {
        medicineId: `MED-${String(timestamp).slice(-6)}-${index}`,
        name: med.name,
        manufacturer: med.manufacturer,
        serialNumber: `SN-${String(Math.random()).substr(2, 8)}`,
        batchNumber: `BATCH-${String(Date.now()).slice(-5)}`,
        quantity: 100 + (index * 50),
        expiryDate: new Date(Date.now() + 365*24*60*60*1000).toISOString().split('T')[0],
        description: `Sample ${med.name} for testing`,
        origin: 'Test Origin',
        manufacturerDID: `did:key:z6Mkr${String(index).padStart(25, '0')}`
    };
}

// ===== EXPORT =====
export {
    uploadProductData,
    createProductData,
    generateSampleProductData
};
