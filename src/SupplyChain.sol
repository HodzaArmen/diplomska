// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title SupplyChain
 * @dev Web3 sledljivost: MetaMask (msg.sender) + walt.id DID + IPFS + handoff dogodki
 */
contract SupplyChain {

    struct User {
        address wallet;
        string did;
        string role;
        bool registered;
    }

    struct Medicine {
        string medicineId;
        string ipfsHash;
        address manufacturer;
        uint256 createdAt;
        string status;
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

    struct Handoff {
        string deliveryId;
        uint256 quantity;
        address actor;
        string actorDID;
        address counterparty;
        string counterpartyDID;
        uint256 timestamp;
        string eventType;
        string vcRef;
    }

    mapping(address => User) public users;
    mapping(string => Medicine) public medicines;
    mapping(string => Transaction[]) public medicineHistory;
    mapping(string => Handoff[]) private handoffLog;

    address[] public userList;
    string[] public medicineList;

    event UserRegistered(address indexed wallet, string did, string role);
    event MedicineRegistered(string medicineId, address manufacturer, string ipfsHash);
    event StatusUpdated(string medicineId, string status, address holder, string holderDID);
    event HandoffRecorded(
        string indexed medicineId,
        string deliveryId,
        string eventType,
        address actor,
        address counterparty,
        uint256 quantity,
        string vcRef
    );

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

    function registerMedicine(string memory _medicineId, string memory _ipfsHash) public {
        require(users[msg.sender].registered, "User must be registered");
        require(bytes(users[msg.sender].role).length > 0, "User must have a role");
        require(bytes(_medicineId).length > 0, "Medicine ID required");
        require(bytes(_ipfsHash).length > 0, "IPFS hash required");

        medicines[_medicineId] = Medicine({
            medicineId: _medicineId,
            ipfsHash: _ipfsHash,
            manufacturer: msg.sender,
            createdAt: block.timestamp,
            status: "MANUFACTURED",
            currentHolder: msg.sender,
            currentHolderDID: users[msg.sender].did
        });

        medicineList.push(_medicineId);
        emit MedicineRegistered(_medicineId, msg.sender, _ipfsHash);

        medicineHistory[_medicineId].push(Transaction({
            medicineId: _medicineId,
            from: address(0),
            fromDID: "system",
            to: msg.sender,
            toDID: users[msg.sender].did,
            timestamp: block.timestamp,
            status: "MANUFACTURED"
        }));
    }

    /**
     * @dev Handoff — msg.sender je akter (pošiljatelj); zgodovina from → counterparty
     */
    function recordHandoff(
        string memory _medicineId,
        string memory _deliveryId,
        uint256 _quantity,
        address _counterparty,
        string memory _counterpartyDID,
        string memory _eventType,
        string memory _vcRef,
        address _newHolder,
        string memory _newHolderDID
    ) public {
        require(users[msg.sender].registered, "User must be registered");
        require(bytes(medicines[_medicineId].medicineId).length > 0, "Medicine not found");
        require(_quantity > 0, "Quantity must be positive");
        require(_counterparty != address(0), "Counterparty required");

        Medicine storage med = medicines[_medicineId];
        address actor = msg.sender;
        string memory actorDID = users[msg.sender].did;

        handoffLog[_medicineId].push(Handoff({
            deliveryId: _deliveryId,
            quantity: _quantity,
            actor: actor,
            actorDID: actorDID,
            counterparty: _counterparty,
            counterpartyDID: _counterpartyDID,
            timestamp: block.timestamp,
            eventType: _eventType,
            vcRef: _vcRef
        }));

        medicineHistory[_medicineId].push(Transaction({
            medicineId: _medicineId,
            from: actor,
            fromDID: actorDID,
            to: _counterparty,
            toDID: _counterpartyDID,
            timestamp: block.timestamp,
            status: _eventType
        }));

        med.status = _eventType;
        med.currentHolder = _newHolder;
        med.currentHolderDID = _newHolderDID;

        emit HandoffRecorded(
            _medicineId,
            _deliveryId,
            _eventType,
            actor,
            _counterparty,
            _quantity,
            _vcRef
        );
        emit StatusUpdated(_medicineId, _eventType, _newHolder, _newHolderDID);
    }

    function updateMedicineStatus(string memory _medicineId, string memory _status) public {
        require(users[msg.sender].registered, "User must be registered");
        require(bytes(medicines[_medicineId].medicineId).length > 0, "Medicine not found");

        Medicine storage medicine = medicines[_medicineId];
        address previousHolder = medicine.currentHolder;
        string memory previousDID = medicine.currentHolderDID;

        medicine.status = _status;
        medicine.currentHolder = msg.sender;
        medicine.currentHolderDID = users[msg.sender].did;

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

    function getUser(address _wallet) public view returns (User memory) {
        return users[_wallet];
    }

    function getMedicine(string memory _medicineId) public view returns (Medicine memory) {
        return medicines[_medicineId];
    }

    function getMedicineHistory(string memory _medicineId)
        public
        view
        returns (Transaction[] memory)
    {
        return medicineHistory[_medicineId];
    }

    function getMedicineHandoffs(string memory _medicineId)
        public
        view
        returns (Handoff[] memory)
    {
        return handoffLog[_medicineId];
    }

    function getUserCount() public view returns (uint256) {
        return userList.length;
    }

    function getMedicineCount() public view returns (uint256) {
        return medicineList.length;
    }

    function verifyMedicineAuthenticity(string memory _medicineId)
        public
        view
        returns (bool, address, string memory)
    {
        Medicine memory medicine = medicines[_medicineId];
        return (bytes(medicine.medicineId).length > 0, medicine.manufacturer, medicine.ipfsHash);
    }
}
