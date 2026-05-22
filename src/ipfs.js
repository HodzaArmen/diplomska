/**
 * ipfs.js
 * Integration with Pinata for storing product data on IPFS
 */

const axios = require('axios');

// Pinata API endpoint
const PINATA_API_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';

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


// ===== EXPORT =====
module.exports = {
    uploadProductData,
    createProductData,
    PINATA_API_URL
};
