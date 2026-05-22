// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title SupplyChain
 * @dev Simple supply chain system linking MetaMask addresses with walt.id DIDs
 * and tracking medicines through their lifecycle
 */
contract SupplyChain {

    // ===== STRUCTURES =====
    struct User {
        address wallet;
        string did;
        string role; // "manufacturer", "transporter", "pharmacy", ..
        bool registered;
    }

    struct Medicine {
        string medicineId;
        string ipfsHash;
        address manufacturer;
        uint256 createdAt;
        string status; // "manufactured", "in_transit", "delivered"
        address currentHolder;
        string currentHolderDID;
    }

    struct Transaction {
        string medicineId;
        address from;
        string fromDID;
        address to;
        string toDID;
        uint256 timestamp;
        string status;
    }

    // ===== MAPPINGS =====
    mapping(address => User) public users;
    mapping(string => Medicine) public medicines;
    mapping(string => Transaction[]) public medicineHistory;

    // ===== ARRAYS =====
    address[] public userList;
    string[] public medicineList;

    // ===== EVENTS =====
    event UserRegistered(address indexed wallet, string did, string role);
    event MedicineRegistered(string medicineId, address manufacturer, string ipfsHash);
    event StatusUpdated(string medicineId, string status, address holder, string holderDID);

    // ===== FUNCTIONS =====

    /**
     * @dev Register a user by linking MetaMask address with walt.id DID
     * @param _did The walt.id DID string (e.g., "did:key:z6Mkr...")
     * @param _role User role: "manufacturer", "transporter", or "pharmacy"
     */
    function registerUser(string memory _did, string memory _role) public {
        require(!users[msg.sender].registered, "User already registered");
        require(bytes(_did).length > 0, "DID cannot be empty");

        users[msg.sender] = User({
            wallet: msg.sender,
            did: _did,
            role: _role,
            registered: true
        });

        userList.push(msg.sender);
        emit UserRegistered(msg.sender, _did, _role);
    }

    /**
     * @dev Register a new medicine
     * @param _medicineId Unique medicine identifier (e.g., "MED-001")
     * @param _ipfsHash IPFS hash containing medicine data
     */
    function registerMedicine(string memory _medicineId, string memory _ipfsHash) public {
        require(users[msg.sender].registered, "User must be registered");
        require(bytes(users[msg.sender].role).length > 0, "User must have a role");
        
        medicines[_medicineId] = Medicine({
            medicineId: _medicineId,
            ipfsHash: _ipfsHash,
            manufacturer: msg.sender,
            createdAt: block.timestamp,
            status: "manufactured",
            currentHolder: msg.sender,
            currentHolderDID: users[msg.sender].did
        });

        medicineList.push(_medicineId);
        emit MedicineRegistered(_medicineId, msg.sender, _ipfsHash);

        // Record initial transaction
        medicineHistory[_medicineId].push(Transaction({
            medicineId: _medicineId,
            from: address(0),
            fromDID: "system",
            to: msg.sender,
            toDID: users[msg.sender].did,
            timestamp: block.timestamp,
            status: "manufactured"
        }));
    }

    /**
     * @dev Update medicine status and current holder
     * @param _medicineId Medicine ID to update
     * @param _status New status (e.g., "in_transit", "delivered")
     */
    function updateMedicineStatus(
        string memory _medicineId,
        string memory _status
    ) public {
        require(users[msg.sender].registered, "User must be registered");
        require(bytes(medicines[_medicineId].medicineId).length > 0, "Medicine not found");

        Medicine storage medicine = medicines[_medicineId];
        address previousHolder = medicine.currentHolder;
        string memory previousDID = medicine.currentHolderDID;

        medicine.status = _status;
        medicine.currentHolder = msg.sender;
        medicine.currentHolderDID = users[msg.sender].did;

        // Record transaction
        medicineHistory[_medicineId].push(Transaction({
            medicineId: _medicineId,
            from: previousHolder,
            fromDID: previousDID,
            to: msg.sender,
            toDID: users[msg.sender].did,
            timestamp: block.timestamp,
            status: _status
        }));

        emit StatusUpdated(_medicineId, _status, msg.sender, users[msg.sender].did);
    }

    // ===== VIEW FUNCTIONS =====

    /**
     * @dev Get user information
     */
    function getUser(address _wallet) public view returns (User memory) {
        return users[_wallet];
    }

    /**
     * @dev Get medicine information
     */
    function getMedicine(string memory _medicineId) public view returns (Medicine memory) {
        return medicines[_medicineId];
    }

    /**
     * @dev Get full medicine transaction history
     */
    function getMedicineHistory(string memory _medicineId) 
        public 
        view 
        returns (Transaction[] memory) 
    {
        return medicineHistory[_medicineId];
    }

    /**
     * @dev Get total number of users
     */
    function getUserCount() public view returns (uint256) {
        return userList.length;
    }

    /**
     * @dev Get total number of medicines
     */
    function getMedicineCount() public view returns (uint256) {
        return medicineList.length;
    }

    /**
     * @dev Verify medicine authenticity by checking manufacturer
     */
    function verifyMedicineAuthenticity(string memory _medicineId) 
        public 
        view 
        returns (bool, address, string memory) 
    {
        Medicine memory medicine = medicines[_medicineId];
        return (bytes(medicine.medicineId).length > 0, medicine.manufacturer, medicine.ipfsHash);
    }
}
