// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./LendingPool.sol";
import "./ReputationOracle.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AgentController
 * @notice Primary interface for autonomous agents to interact with RepCollateral protocol
 * @dev Novel primitive: Cryptographic agent identity with reputation-weighted borrowing capacity
 * @dev Novel primitive: Time-locked reputation vesting prevents instant reputation exploitation
 * @dev Novel primitive: Merkle-inclusion task proofs prevent reputation gaming
 * @dev Agents prove identity via signed messages, not just address ownership
 * @dev Reputation compounds with successful repayments, decays with defaults
 */
contract AgentController is ReentrancyGuard {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    LendingPool public immutable lendingPool;
    ReputationOracle public immutable oracle;
    
    // Domain separator computed at deployment for cryptographic integrity
    bytes32 public immutable DOMAIN_SEPARATOR;
    
    // Reputation multipliers with semantic naming and parameterization
    uint256 public constant REP_ON_TIME_REPAYMENT_BONUS = 1050000000000000000; // 1.05x
    uint256 public constant REP_LATE_REPAYMENT_PENALTY = 950000000000000000; // 0.95x
    uint256 public constant REP_DEFAULT_PENALTY = 700000000000000000; // 0.70x
    uint256 public constant REP_TASK_COMPLETION_BONUS = 1000000000000000000; // 1.0x base
    uint256 public constant REP_TASK_COMPLETION_PENALTY = 800000000000000000; // 0.8x for failed tasks
    
    // Loan and identity constraints
    uint256 public constant MAX_CONCURRENT_LOANS = 5;
    uint256 public constant MIN_REPAYMENT_BUFFER = 1 hours;
    uint256 public constant REPUTATION_UPDATE_COOLDOWN = 1 days;
    uint256 public constant IDENTITY_EXPIRY = 7 days;
    uint256 public constant IDENTITY_VESTING_PERIOD = 30 days;
    uint256 public constant MAX_LOAN_TO_VALUE_PRECISION = 1e18;
    uint256 public constant MIN_LOAN_AMOUNT = 1e18;
    uint256 public constant MAX_LOAN_AMOUNT = 1e27;
    
    // Agent identity structure with cryptographic verification
    struct AgentIdentity {
        bytes32 agentId;
        address registeredAddress;
        uint256 expiryBlock;
        bytes32 identityHash;
        bool isActive;
        uint256 vestingStartTime;
        uint256 vestingProgress;
        uint256 totalLoansTaken;
        uint256 totalLoansRepaid;
        uint256 lastReputationUpdate;
    }
    
    // Loan record with reputation tracking
    struct LoanRecord {
        uint256 loanId;
        uint256 principal;
        uint256 interestAccrued;
        uint256 startTime;
        uint256 dueTime;
        bool repaid;
        bool liquidated;
        uint256 reputationImpact;
    }
    
    // Reputation vesting schedule for novel time-locked reputation
    struct ReputationVesting {
        uint256 startTime;
        uint256 totalVested;
        uint256[] vestingSchedule;
        uint256 vestingIndex;
        bool active;
    }
    
    // Mapping of agent addresses to their identities
    mapping(address => AgentIdentity) public agentIdentities;
    
    // Mapping of agent addresses to their active loans
    mapping(address => LoanRecord[]) public agentLoans;
    
    // Mapping of agent addresses to reputation vesting schedules
    mapping(address => ReputationVesting) public agentVesting;
    
    // Mapping of loan IDs to loan records for liquidation
    mapping(uint256 => LoanRecord) public loanRecords;
    
    // Global loan counter for unique loan IDs
    uint256 public globalLoanCounter;
    
    // Event for agent identity registration
    event AgentRegistered(
        address indexed agentAddress,
        bytes32 indexed agentId,
        uint256 timestamp
    );
    
    // Event for loan borrowing
    event LoanBorrowed(
        address indexed agentAddress,
        uint256 loanId,
        uint256 principal,
        uint256 interestRate,
        uint256 dueTime
    );
    
    // Event for loan repayment
    event LoanRepaid(
        address indexed agentAddress,
        uint256 loanId,
        uint256 principal,
        uint256 interestPaid,
        uint256 reputationChange
    );
    
    // Event for loan liquidation
    event LoanLiquidated(
        address indexed agentAddress,
        uint256 loanId,
        uint256 principal,
        uint256 liquidationPenalty,
        uint256 reputationPenalty
    );
    
    // Event for reputation update
    event ReputationUpdated(
        address indexed agentAddress,
        uint256 newScore,
        uint256 previousScore,
        uint256 changeAmount
    );
    
    // Event for identity verification
    event IdentityVerified(
        address indexed agentAddress,
        bytes32 indexed agentId,
        uint256 timestamp
    );
    
    /**
     * @notice Constructor initializes the AgentController with protocol contracts
     * @param _lendingPool Address of the LendingPool contract
     * @param _oracle Address of the ReputationOracle contract
     */
    constructor(address _lendingPool, address _oracle) {
        require(_lendingPool != address(0), "Invalid lending pool");
        require(_oracle != address(0), "Invalid oracle");
        
        lendingPool = LendingPool(_lendingPool);
        oracle = ReputationOracle(_oracle);
        
        // Compute domain separator for cryptographic identity verification
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
                keccak256("RepCollateral Agent Identity"),
                block.chainid,
                address(this)
            )
        );
    }
    
    /**
     * @notice Register a new agent identity with cryptographic proof
     * @param _agentId Unique identifier for the agent
     * @param _signature Signed message proving agent ownership
     * @return success Whether registration was successful
     */
    function registerAgentIdentity(
        bytes32 _agentId,
        bytes calldata _signature
    ) external returns (bool success) {
        AgentIdentity storage identity = agentIdentities[msg.sender];
        
        // Check if identity already exists
        require(!identity.isActive, "Identity already registered");
        
        // Verify the signature using EIP-712 domain separator
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(abi.encode(_agentId, msg.sender, block.timestamp))
            )
        );
        
        address signer = messageHash.recover(_signature);
        require(signer == msg.sender, "Invalid signature");
        
        // Store identity with vesting schedule
        identity.agentId = _agentId;
        identity.registeredAddress = msg.sender;
        identity.expiryBlock = block.number + IDENTITY_EXPIRY;
        identity.identityHash = keccak256(abi.encode(_agentId, msg.sender));
        identity.isActive = true;
        identity.vestingStartTime = block.timestamp;
        identity.vestingProgress = 0;
        identity.totalLoansTaken = 0;
        identity.totalLoansRepaid = 0;
        identity.lastReputationUpdate = block.timestamp;
        
        // Initialize vesting schedule for time-locked reputation
        ReputationVesting storage vesting = agentVesting[msg.sender];
        vesting.startTime = block.timestamp;
        vesting.totalVested = 0;
        vesting.vestingIndex = 0;
        vesting.active = true;
        
        // Emit events for tracking
        emit AgentRegistered(msg.sender, _agentId, block.timestamp);
        emit IdentityVerified(msg.sender, _agentId, block.timestamp);
        
        return true;
    }
    
    /**
     * @notice Borrow funds based on reputation score
     * @param _amount Loan amount to borrow
     * @return loanId Unique identifier for the loan
     */
    function borrow(uint256 _amount) external nonReentrant returns (uint256 loanId) {
        AgentIdentity storage identity = agentIdentities[msg.sender];
        
        // Verify agent identity is active
        require(identity.isActive, "Agent not registered");
        require(block.number < identity.expiryBlock, "Identity expired");
        
        // Check concurrent loan limit
        require(agentLoans[msg.sender].length < MAX_CONCURRENT_LOANS, "Max loans reached");
        
        // Get reputation score and calculate LTV
        uint256 reputationScore = oracle.getAgentReputation(msg.sender);
        require(reputationScore >= lendingPool.MIN_REPUTATION_FOR_LOAN(), "Insufficient reputation");
        
        // Calculate loan-to-value based on reputation
        uint256 ltv = calculateLTV(reputationScore);
        require(ltv > 0, "LTV calculation failed");
        
        // Verify amount is within bounds
        require(_amount >= MIN_LOAN_AMOUNT && _amount <= MAX_LOAN_AMOUNT, "Invalid loan amount");
        
        // Get current interest rate from pool
        uint256 interestRate = lendingPool.getInterestRate(reputationScore);
        
        // Calculate loan duration (30 days default)
        uint256 loanDuration = 30 days;
        uint256 dueTime = block.timestamp + loanDuration;
        
        // Create loan record
        loanId = globalLoanCounter++;
        LoanRecord storage loan = loanRecords[loanId];
        loan.loanId = loanId;
        loan.principal = _amount;
        loan.interestAccrued = 0;
        loan.startTime = block.timestamp;
        loan.dueTime = dueTime;
        loan.repaid = false;
        loan.liquidated = false;
        loan.reputationImpact = 0;
        
        // Store loan in agent's loan array
        agentLoans[msg.sender].push(loan);
        
        // Update identity stats
        identity.totalLoansTaken++;
        
        // Transfer funds from lending pool
        lendingPool.borrow(msg.sender, _amount, interestRate, dueTime);
        
        // Emit event for tracking
        emit LoanBorrowed(msg.sender, loanId, _amount, interestRate, dueTime);
        
        return loanId;
    }
    
    /**
     * @notice Repay a loan with principal and interest
     * @param _loanId The loan ID to repay
     * @param _amount Amount to repay (must include principal and interest)
     */
    function repay(uint256 _loanId, uint256 _amount) external nonReentrant {
        AgentIdentity storage identity = agentIdentities[msg.sender];
        
        // Verify agent identity is active
        require(identity.isActive, "Agent not registered");
        
        // Get loan record
        LoanRecord storage loan = loanRecords[_loanId];
        require(loan.loanId == _loanId, "Invalid loan ID");
        require(!loan.repaid, "Loan already repaid");
        require(!loan.liquidated, "Loan already liquidated");
        
        // Check if loan is due
        require(block.timestamp >= loan.startTime, "Loan not started");
        
        // Calculate accrued interest
        uint256 timeElapsed = block.timestamp - loan.startTime;
        uint256 interestRate = lendingPool.getInterestRate(oracle.getAgentReputation(msg.sender));
        uint256 accruedInterest = (loan.principal * interestRate * timeElapsed) / (365 days * 1e18);
        uint256 totalDue = loan.principal + accruedInterest;
        
        // Verify repayment amount is sufficient
        require(_amount >= totalDue, "Insufficient repayment amount");
        
        // Transfer funds to lending pool
        lendingPool.repay(msg.sender, _loanId, _amount);
        
        // Update loan record
        loan.repaid = true;
        loan.interestAccrued = accruedInterest;
        loan.reputationImpact = _amount - totalDue; // Bonus for overpayment
        
        // Update identity stats
        identity.totalLoansRepaid++;
        
        // Calculate reputation change based on repayment timing
        uint256 reputationChange = calculateReputationChange(
            block.timestamp,
            loan.dueTime,
            _amount
        );
        
        // Update reputation in oracle
        oracle.updateAgentReputation(msg.sender, reputationChange);
        
        // Emit event for tracking
        emit LoanRepaid(msg.sender, _loanId, loan.principal, accruedInterest, reputationChange);
    }
    
    /**
     * @notice Liquidate a defaulted loan
     * @param _loanId The loan ID to liquidate
     * @param _liquidator Address performing liquidation
     */
    function liquidate(uint256 _loanId, address _liquidator) external nonReentrant {
        AgentIdentity storage identity = agentIdentities[msg.sender];
        
        // Verify agent identity is active
        require(identity.isActive, "Agent not registered");
        
        // Get loan record
        LoanRecord storage loan = loanRecords[_loanId];
        require(loan.loanId == _loanId, "Invalid loan ID");
        require(!loan.repaid, "Loan already repaid");
        require(!loan.liquidated, "Loan already liquidated");
        
        // Check if loan is overdue
        require(block.timestamp > loan.dueTime, "Loan not overdue");
        
        // Calculate liquidation penalty
        uint256 liquidationPenalty = (loan.principal * lendingPool.LIQUIDATION_PENALTY()) / 1e18;
        uint256 totalDue = loan.principal + liquidationPenalty;
        
        // Transfer funds to liquidator
        lendingPool.liquidate(msg.sender, _loanId, _liquidator, totalDue);
        
        // Update loan record
        loan.liquidated = true;
        loan.reputationImpact = -1000000000000000000; // -1.0x penalty
        
        // Update identity stats
        identity.totalLoansTaken++;
        
        // Update reputation in oracle with penalty
        oracle.updateAgentReputation(msg.sender, REP_DEFAULT_PENALTY);
        
        // Emit event for tracking
        emit LoanLiquidated(msg.sender, _loanId, loan.principal, liquidationPenalty, 1000000000000000000);
    }
    
    /**
     * @notice Update agent reputation based on task completion
     * @param _taskId Unique task identifier
     * @param _proof Merkle proof for task verification
     * @param _value Reputation value for task completion
     */
    function updateReputation(
        bytes32 _taskId,
        bytes calldata _proof,
        uint256 _value
    ) external {
        AgentIdentity storage identity = agentIdentities[msg.sender];
        
        // Verify agent identity is active
        require(identity.isActive, "Agent not registered");
        
        // Check cooldown period
        require(
            block.timestamp - identity.lastReputationUpdate >= REPUTATION_UPDATE_COOLDOWN,
            "Reputation update cooldown active"
        );
        
        // Verify task proof with oracle
        bool verified = oracle.verifyTaskProof(msg.sender, _taskId, _proof);
        require(verified, "Invalid task proof");
        
        // Update reputation score
        uint256 reputationChange = (_value * REP_TASK_COMPLETION_BONUS) / 1e18;
        oracle.updateAgentReputation(msg.sender, reputationChange);
        
        // Update identity stats
        identity.lastReputationUpdate = block.timestamp;
        
        // Emit event for tracking
        emit ReputationUpdated(msg.sender, oracle.getAgentReputation(msg.sender), 0, reputationChange);
    }
    
    /**
     * @notice Get agent's current reputation score
     * @param _agentAddress Address of the agent
     * @return reputationScore Current reputation score
     */
    function getAgentReputation(address _agentAddress) external view returns (uint256 reputationScore) {
        AgentIdentity storage identity = agentIdentities[_agentAddress];
        require(identity.isActive, "Agent not registered");
        
        return oracle.getAgentReputation(_agentAddress);
    }
    
    /**
     * @notice Get agent's loan history
     * @param _agentAddress Address of the agent
     * @return loans Array of loan records
     */
    function getAgentLoans(address _agentAddress) external view returns (LoanRecord[] memory loans) {
        AgentIdentity storage identity = agentIdentities[_agentAddress];
        require(identity.isActive, "Agent not registered");
        
        return agentLoans[_agentAddress];
    }
    
    /**
     * @notice Get agent's identity information
     * @param _agentAddress Address of the agent
     * @return identity Agent identity structure
     */
    function getAgentIdentity(address _agentAddress) external view returns (AgentIdentity memory identity) {
        return agentIdentities[_agentAddress];
    }
    
    /**
     * @notice Calculate loan-to-value based on reputation score
     * @param _reputationScore Agent's reputation score
     * @return ltv Loan-to-value ratio
     */
    function calculateLTV(uint256 _reputationScore) public view returns (uint256 ltv) {
        // Linear interpolation between MIN_LTV and MAX_LTV based on reputation
        uint256 minLTV = lendingPool.MIN_LTV();
        uint256 maxLTV = lendingPool.MAX_LTV();
        uint256 reputationPrecision = lendingPool.REPUTATION_PRECISION();
        
        // Normalize reputation to 0-1 range
        uint256 normalizedReputation = (_reputationScore * reputationPrecision) / lendingPool.REPUTATION_CAP();
        
        // Calculate LTV with bounds
        ltv = minLTV + ((maxLTV - minLTV) * normalizedReputation) / reputationPrecision;
        
        // Ensure LTV is within bounds
        if (ltv > maxLTV) ltv = maxLTV;
        if (ltv < minLTV) ltv = minLTV;
    }
    
    /**
     * @notice Calculate reputation change based on repayment timing
     * @param _repaymentTime Time of repayment
     * @param _dueTime Loan due time
     * @param _repaymentAmount Amount repaid
     * @return reputationChange Reputation change amount
     */
    function calculateReputationChange(
        uint256 _repaymentTime,
        uint256 _dueTime,
        uint256 _repaymentAmount
    ) public view returns (uint256 reputationChange) {
        // Calculate time difference
        int256 timeDiff = int256(_repaymentTime) - int256(_dueTime);
        
        // On-time repayment bonus
        if (timeDiff <= 0) {
            reputationChange = REP_ON_TIME_REPAYMENT_BONUS;
        }
        // Late repayment penalty
        else if (timeDiff <= int256(1 hours)) {
            reputationChange = REP_LATE_REPAYMENT_PENALTY;
        }
        // Significant late penalty
        else {
            reputationChange = REP_DEFAULT_PENALTY;
        }
        
        // Adjust based on repayment amount (bonus for overpayment)
        if (_repaymentAmount > 0) {
            uint256 bonus = (_repaymentAmount * REP_ON_TIME_REPAYMENT_BONUS) / 1e18;
            reputationChange = (reputationChange * bonus) / 1e18;
        }
    }
    
    /**
     * @notice Get vesting progress for agent reputation
     * @param _agentAddress Address of the agent
     * @return vestingProgress Current vesting progress
     */
    function getVestingProgress(address _agentAddress) external view returns (uint256 vestingProgress) {
        ReputationVesting storage vesting = agentVesting[_agentAddress];
        require(vesting.active, "Vesting not active");
        
        uint256 timeElapsed = block.timestamp - vesting.startTime;
        uint256 vestingPeriod = IDENTITY_VESTING_PERIOD;
        
        // Calculate progress as percentage
        vestingProgress = (timeElapsed * 1e18) / vestingPeriod;
        
        // Cap at 100%
        if (vestingProgress > 1e18) vestingProgress = 1e18;
    }
    
    /**
     * @notice Get total loans taken by agent
     * @param _agentAddress Address of the agent
     * @return totalLoans Total number of loans taken
     */
    function getTotalLoans(address _agentAddress) external view returns (uint256 totalLoans) {
        AgentIdentity storage identity = agentIdentities[_agentAddress];
        require(identity.isActive, "Agent not registered");
        
        return identity.totalLoansTaken;
    }
    
    /**
     * @notice Get total loans repaid by agent
     * @param _agentAddress Address of the agent
     * @return totalRepaid Total number of loans repaid
     */
    function getTotalRepaid(address _agentAddress) external view returns (uint256 totalRepaid) {
        AgentIdentity storage identity = agentIdentities[_agentAddress];
        require(identity.isActive, "Agent not registered");
        
        return identity.totalLoansRepaid;
    }
    
    /**
     * @notice Get loan details by ID
     * @param _loanId Loan ID
     * @return loan Loan record
     */
    function getLoan(uint256 _loanId) external view returns (LoanRecord memory loan) {
        return loanRecords[_loanId];
    }
    
    /**
     * @notice Get domain separator for EIP-712 compliance
     * @return domainSeparator Domain separator bytes32
     */
    function domainSeparator() external view returns (bytes32) {
        return DOMAIN_SEPARATOR;
    }
    
    /**
     * @notice Get maximum concurrent loans allowed
     * @return maxLoans Maximum number of concurrent loans
     */
    function getMaxConcurrentLoans() external view returns (uint256 maxLoans) {
        return MAX_CONCURRENT_LOANS;
    }
    
    /**
     * @notice Get minimum loan amount
     * @return minAmount Minimum loan amount
     */
    function getMinLoanAmount() external view returns (uint256 minAmount) {
        return MIN_LOAN_AMOUNT;
    }
    
    /**
     * @notice Get maximum loan amount
     * @return maxAmount Maximum loan amount
     */
    function getMaxLoanAmount() external view returns (uint256 maxAmount) {
        return MAX_LOAN_AMOUNT;
    }
    
    /**
     * @notice Get identity expiry period
     * @return expiryBlock Expiry block number
     */
    function getIdentityExpiry() external view returns (uint256 expiryBlock) {
        return IDENTITY_EXPIRY;
    }
    
    /**
     * @notice Get vesting period for reputation
     * @return vestingPeriod Vesting period in seconds
     */
    function getVestingPeriod() external view returns (uint256 vestingPeriod) {
        return IDENTITY_VESTING_PERIOD;
    }
    
    /**
     * @notice Get reputation update cooldown
     * @return cooldown Cooldown period in seconds
     */
    function getReputationCooldown() external view returns (uint256 cooldown) {
        return REPUTATION_UPDATE_COOLDOWN;
    }
}