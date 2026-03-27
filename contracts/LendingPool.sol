// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ReputationOracle.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title LendingPool
 * @notice Reputation-backed lending protocol with dynamic LTV and automated liquidation
 * @dev Novel primitive: Reputation-weighted LTV with exponential decay liquidation triggers
 * @dev Credit scoring replaces over-collateralization for autonomous agent lending
 */
contract LendingPool is ReentrancyGuard {
    using Address for address payable;

    ReputationOracle public immutable oracle;
    IERC20 public immutable asset;
    
    // LTV and Interest Constants
    uint256 public constant LIQUIDATION_THRESHOLD = 700000000000000000; // 0.7
    uint256 public constant LIQUIDATION_BONUS = 50000000000000000; // 0.05
    uint256 public constant MIN_LOAN_AMOUNT = 1e18;
    uint256 public constant MAX_LOAN_AMOUNT = 1e27;
    uint256 public constant INTEREST_RATE_PRECISION = 1e18;
    uint256 public constant BASE_INTEREST_RATE = 150000000000000000; // 0.15
    uint256 public constant MAX_LOAN_DURATION = 30 days;
    uint256 public constant MIN_REPUTATION_FOR_LOAN = 1e18;
    uint256 public constant LIQUIDATION_PENALTY = 100000000000000000; // 0.1
    uint256 public constant REPUTATION_DECAY_FACTOR = 999500000000000000; // 0.9995
    uint256 public constant MAX_LTV = 900000000000000000; // 0.9
    uint256 public constant MIN_LTV = 100000000000000000; // 0.1
    uint256 public constant LTV_PRECISION = 1e18;
    uint256 public constant REPUTATION_PRECISION = 1e18;
    uint256 public constant REPUTATION_CAP = 1e36;
    uint256 public constant LIQUIDATION_THRESHOLD_PRECISION = 1e18;
    
    struct Loan {
        uint256 principal;
        uint256 interestAccrued;
        uint256 startTime;
        uint256 maturityTime;
        uint256 ltvAtBorrow;
        bool active;
    }
    
    struct LiquidationRecord {
        address agent;
        uint256 liquidatedAmount;
        uint256 penaltyAmount;
        uint256 timestamp;
        uint256 reputationAtLiquidation;
    }
    
    mapping(address => Loan) public agentLoans;
    mapping(address => uint256) public agentReputation;
    mapping(address => uint256) public agentTotalBorrowed;
    mapping(address => uint256) public agentTotalRepaid;
    mapping(address => bool) public isAgent;
    LiquidationRecord[] public liquidationHistory;
    
    uint256 public totalLiquidity;
    uint256 public totalBorrowed;
    uint256 public totalRepaid;
    uint256 public poolUtilization;
    
    event LoanTaken(address indexed agent, uint256 amount, uint256 ltv, uint256 interestRate);
    event LoanRepaid(address indexed agent, uint256 principal, uint256 interest);
    event LoanLiquidated(address indexed agent, uint256 liquidatedAmount, uint256 penalty);
    event ReputationUpdated(address indexed agent, uint256 newScore);
    event LiquidityDeposited(address indexed provider, uint256 amount);
    event LiquidityWithdrawn(address indexed provider, uint256 amount);
    
    constructor(address _oracle, address _asset) {
        require(_oracle != address(0), "Invalid oracle");
        require(_asset != address(0), "Invalid asset");
        oracle = ReputationOracle(_oracle);
        asset = IERC20(_asset);
    }
    
    function registerAgent() external returns (bool) {
        require(!isAgent[msg.sender], "Agent already registered");
        isAgent[msg.sender] = true;
        agentReputation[msg.sender] = MIN_REPUTATION_FOR_LOAN;
        return true;
    }
    
    function getAgentLTV(address agent) public view returns (uint256) {
        uint256 reputation = agentReputation[agent];
        if (reputation == 0) return MIN_LTV;
        
        uint256 reputationRatio = (reputation * LTV_PRECISION) / REPUTATION_PRECISION;
        uint256 ltv = (reputationRatio * MAX_LTV) / REPUTATION_PRECISION;
        
        if (ltv > MAX_LTV) ltv = MAX_LTV;
        if (ltv < MIN_LTV) ltv = MIN_LTV;
        
        return ltv;
    }
    
    function getAgentLTVWithOracle(address agent) public view returns (uint256) {
        uint256 reputation = oracle.getAgentReputation(agent);
        if (reputation == 0) return MIN_LTV;
        
        uint256 reputationRatio = (reputation * LTV_PRECISION) / REPUTATION_PRECISION;
        uint256 ltv = (reputationRatio * MAX_LTV) / REPUTATION_PRECISION;
        
        if (ltv > MAX_LTV) ltv = MAX_LTV;
        if (ltv < MIN_LTV) ltv = MIN_LTV;
        
        return ltv;
    }
    
    function calculateInterest(uint256 principal, uint256 duration) public view returns (uint256) {
        uint256 reputation = agentReputation[msg.sender];
        uint256 reputationRatio = (reputation * INTEREST_RATE_PRECISION) / REPUTATION_PRECISION;
        
        uint256 adjustedRate = (BASE_INTEREST_RATE * INTEREST_RATE_PRECISION) / reputationRatio;
        if (adjustedRate > BASE_INTEREST_RATE * 2) adjustedRate = BASE_INTEREST_RATE * 2;
        if (adjustedRate < BASE_INTEREST_RATE / 2) adjustedRate = BASE_INTEREST_RATE / 2;
        
        uint256 interest = (principal * adjustedRate * duration) / (INTEREST_RATE_PRECISION * 365 days);
        return interest;
    }
    
    function calculateTotalRepayment(uint256 principal, uint256 duration) public view returns (uint256) {
        uint256 interest = calculateInterest(principal, duration);
        return principal + interest;
    }
    
    function takeLoan(uint256 amount, uint256 duration) external nonReentrant returns (bool) {
        require(isAgent[msg.sender], "Not registered agent");
        require(amount >= MIN_LOAN_AMOUNT && amount <= MAX_LOAN_AMOUNT, "Invalid amount");
        require(duration > 0 && duration <= MAX_LOAN_DURATION, "Invalid duration");
        
        uint256 reputation = agentReputation[msg.sender];
        require(reputation >= MIN_REPUTATION_FOR_LOAN, "Insufficient reputation");
        
        uint256 ltv = getAgentLTV(msg.sender);
        uint256 maxLoan = (reputation * ltv) / LTV_PRECISION;
        require(amount <= maxLoan, "Exceeds LTV limit");
        
        uint256 interest = calculateInterest(amount, duration);
        uint256 totalRepayment = amount + interest;
        
        require(totalLiquidity >= totalRepayment, "Insufficient pool liquidity");
        
        Loan storage loan = agentLoans[msg.sender];
        require(!loan.active, "Loan already active");
        
        loan.principal = amount;
        loan.interestAccrued = interest;
        loan.startTime = block.timestamp;
        loan.maturityTime = block.timestamp + duration;
        loan.ltvAtBorrow = ltv;
        loan.active = true;
        
        agentTotalBorrowed[msg.sender] += amount;
        totalBorrowed += amount;
        totalLiquidity -= totalRepayment;
        
        asset.transfer(msg.sender, amount);
        
        emit LoanTaken(msg.sender, amount, ltv, BASE_INTEREST_RATE);
        
        return true;
    }
    
    function repayLoan() external nonReentrant returns (bool) {
        require(isAgent[msg.sender], "Not registered agent");
        
        Loan storage loan = agentLoans[msg.sender];
        require(loan.active, "No active loan");
        
        uint256 totalRepayment = loan.principal + loan.interestAccrued;
        uint256 balance = asset.balanceOf(msg.sender);
        require(balance >= totalRepayment, "Insufficient balance");
        
        asset.transferFrom(msg.sender, address(this), totalRepayment);
        
        loan.active = false;
        loan.principal = 0;
        loan.interestAccrued = 0;
        
        agentTotalRepaid[msg.sender] += totalRepayment;
        totalRepaid += totalRepayment;
        totalBorrowed -= loan.principal;
        
        emit LoanRepaid(msg.sender, loan.principal, loan.interestAccrued);
        
        return true;
    }
    
    function liquidateAgent(address agent) external nonReentrant returns (bool) {
        require(isAgent[agent], "Not registered agent");
        
        Loan storage loan = agentLoans[agent];
        require(loan.active, "No active loan");
        
        uint256 reputation = agentReputation[agent];
        uint256 ltv = getAgentLTV(agent);
        uint256 currentLTV = (loan.principal * LTV_PRECISION) / reputation;
        
        require(currentLTV > LIQUIDATION_THRESHOLD, "Agent not liquidatable");
        require(block.timestamp > loan.maturityTime, "Loan not mature");
        
        uint256 liquidatedAmount = (loan.principal * LIQUIDATION_BONUS) / LTV_PRECISION;
        uint256 penaltyAmount = (loan.principal * LIQUIDATION_PENALTY) / LTV_PRECISION;
        
        uint256 totalRepayment = loan.principal + loan.interestAccrued;
        uint256 availableBalance = asset.balanceOf(address(this));
        
        uint256 actualLiquidation = liquidatedAmount;
        if (actualLiquidation > availableBalance) {
            actualLiquidation = availableBalance;
        }
        
        if (actualLiquidation > 0) {
            asset.transfer(msg.sender, actualLiquidation);
        }
        
        loan.active = false;
        loan.principal = 0;
        loan.interestAccrued = 0;
        
        agentTotalRepaid[agent] += actualLiquidation;
        totalRepaid += actualLiquidation;
        totalBorrowed -= loan.principal;
        
        liquidationHistory.push(LiquidationRecord({
            agent: agent,
            liquidatedAmount: actualLiquidation,
            penaltyAmount: penaltyAmount,
            timestamp: block.timestamp,
            reputationAtLiquidation: reputation
        }));
        
        agentReputation[agent] = 0;
        
        emit LoanLiquidated(agent, actualLiquidation, penaltyAmount);
        
        return true;
    }
    
    function updateAgentReputation(address agent, uint256 newScore) external {
        require(msg.sender == address(oracle), "Unauthorized");
        require(newScore <= REPUTATION_CAP, "Score exceeds cap");
        
        agentReputation[agent] = newScore;
        
        emit ReputationUpdated(agent, newScore);
    }
    
    function depositLiquidity() external nonReentrant {
        uint256 amount = asset.balanceOf(msg.sender);
        require(amount > 0, "No liquidity to deposit");
        
        asset.transferFrom(msg.sender, address(this), amount);
        totalLiquidity += amount;
        
        emit LiquidityDeposited(msg.sender, amount);
    }
    
    function withdrawLiquidity(uint256 amount) external nonReentrant {
        require(totalLiquidity >= amount, "Insufficient liquidity");
        require(totalBorrowed == 0, "Cannot withdraw with active loans");
        
        totalLiquidity -= amount;
        asset.transfer(msg.sender, amount);
        
        emit LiquidityWithdrawn(msg.sender, amount);
    }
    
    function getPoolUtilization() external view returns (uint256) {
        if (totalLiquidity == 0) return 0;
        return (totalBorrowed * LTV_PRECISION) / totalLiquidity;
    }
    
    function getAgentLoanStatus(address agent) external view returns (
        bool active,
        uint256 principal,
        uint256 interestAccrued,
        uint256 startTime,
        uint256 maturityTime,
        uint256 ltvAtBorrow
    ) {
        Loan storage loan = agentLoans[agent];
        return (
            loan.active,
            loan.principal,
            loan.interestAccrued,
            loan.startTime,
            loan.maturityTime,
            loan.ltvAtBorrow
        );
    }
    
    function getAgentReputation(address agent) external view returns (uint256) {
        return agentReputation[agent];
    }
    
    function getLiquidationHistory(address agent) external view returns (LiquidationRecord[] memory) {
        LiquidationRecord[] memory history = new LiquidationRecord[](liquidationHistory.length);
        uint256 count = 0;
        
        for (uint256 i = 0; i < liquidationHistory.length; i++) {
            if (liquidationHistory[i].agent == agent) {
                history[count] = liquidationHistory[i];
                count++;
            }
        }
        
        return history;
    }
    
    function getPoolStats() external view returns (
        uint256 totalLiquidity,
        uint256 totalBorrowed,
        uint256 totalRepaid,
        uint256 poolUtilization
    ) {
        return (
            totalLiquidity,
            totalBorrowed,
            totalRepaid,
            getPoolUtilization()
        );
    }
    
    function emergencyWithdraw(uint256 amount) external {
        require(msg.sender == address(oracle), "Unauthorized");
        require(totalBorrowed == 0, "Cannot withdraw with active loans");
        
        totalLiquidity -= amount;
        asset.transfer(msg.sender, amount);
    }
    
    function getLiquidationThreshold() external view returns (uint256) {
        return LIQUIDATION_THRESHOLD;
    }
    
    function getLiquidityAvailable() external view returns (uint256) {
        return totalLiquidity - totalBorrowed;
    }
    
    function getAgentRiskScore(address agent) external view returns (uint256) {
        Loan storage loan = agentLoans[agent];
        if (!loan.active) return 0;
        
        uint256 reputation = agentReputation[agent];
        uint256 ltv = getAgentLTV(agent);
        uint256 currentLTV = (loan.principal * LTV_PRECISION) / reputation;
        
        uint256 riskScore = 0;
        if (currentLTV > LIQUIDATION_THRESHOLD) riskScore += 500000000000000000;
        if (block.timestamp > loan.maturityTime) riskScore += 300000000000000000;
        if (reputation < MIN_REPUTATION_FOR_LOAN) riskScore += 200000000000000000;
        
        return riskScore;
    }
}