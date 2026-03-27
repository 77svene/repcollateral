// SPDX-License-Identifier: MIT
import { ethers } from 'ethers';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * @title AgentService
 * @notice Autonomous agent interface for RepCollateral protocol
 * @dev Novel primitive: Cryptographic task attestation with Merkle-inclusion proofs
 * @dev Novel primitive: Reputation-weighted loan capacity with exponential decay
 * @dev Novel primitive: Time-locked reputation vesting prevents instant exploitation
 */
class AgentService {
  constructor({ provider, signer, contractAddresses, abiPaths }) {
    this.provider = provider;
    this.signer = signer;
    this.address = signer.address;
    this.contractAddresses = contractAddresses;
    this.abiPaths = abiPaths;
    
    this.lendingPool = new ethers.Contract(
      contractAddresses.lendingPool,
      abiPaths.lendingPool,
      signer
    );
    
    this.agentController = new ethers.Contract(
      contractAddresses.agentController,
      abiPaths.agentController,
      signer
    );
    
    this.reputationOracle = new ethers.Contract(
      contractAddresses.reputationOracle,
      abiPaths.reputationOracle,
      signer
    );
    
    this._loanEventFilter = null;
    this._repaymentEventFilter = null;
    this._liquidationEventFilter = null;
    this._taskProofEventFilter = null;
    
    this._eventHandlers = new Map();
    this._pendingLoans = new Map();
    this._taskProofs = new Map();
    
    this._initEventFilters();
  }
  
  _initEventFilters() {
    this._loanEventFilter = this.lendingPool.filters.LoanRequested();
    this._repaymentEventFilter = this.lendingPool.filters.RepaymentMade();
    this._liquidationEventFilter = this.lendingPool.filters.LiquidationExecuted();
    this._taskProofEventFilter = this.agentController.filters.TaskProofSubmitted();
  }
  
  async _getContractConstants() {
    const [
      maxConcurrentLoans,
      minRepaymentBuffer,
      reputationUpdateCooldown,
      identityExpiry,
      reputationOnTimeRepaymentBonus,
      reputationLateRepaymentPenalty,
      reputationDefaultPenalty,
      reputationTaskCompletionBonus,
      reputationTaskCompletionPenalty,
      liquidationThreshold,
      liquidationBonus,
      minLoanAmount,
      maxLoanAmount,
      interestRatePrecision,
      baseInterestRate,
      maxLoanDuration,
      minReputationForLoan,
      reputationDecayFactor,
      maxLTV,
      minLTV,
      ltvPrecision,
      reputationPrecision,
      reputationCap,
      decayRate,
      decayWindow,
      maxDecayHistory,
      maxProofHistory,
      minTaskValue,
      maxTaskValue
    ] = await Promise.all([
      this.agentController.MAX_CONCURRENT_LOANS(),
      this.agentController.MIN_REPAYMENT_BUFFER(),
      this.agentController.REPUTATION_UPDATE_COOLDOWN(),
      this.agentController.IDENTITY_EXPIRY(),
      this.agentController.REP_ON_TIME_REPAYMENT_BONUS(),
      this.agentController.REP_LATE_REPAYMENT_PENALTY(),
      this.agentController.REP_DEFAULT_PENALTY(),
      this.agentController.REP_TASK_COMPLETION_BONUS(),
      this.agentController.REP_TASK_COMPLETION_PENALTY(),
      this.lendingPool.LIQUIDATION_THRESHOLD(),
      this.lendingPool.LIQUIDATION_BONUS(),
      this.lendingPool.MIN_LOAN_AMOUNT(),
      this.lendingPool.MAX_LOAN_AMOUNT(),
      this.lendingPool.INTEREST_RATE_PRECISION(),
      this.lendingPool.BASE_INTEREST_RATE(),
      this.lendingPool.MAX_LOAN_DURATION(),
      this.lendingPool.MIN_REPUTATION_FOR_LOAN(),
      this.lendingPool.REPUTATION_DECAY_FACTOR(),
      this.lendingPool.MAX_LTV(),
      this.lendingPool.MIN_LTV(),
      this.lendingPool.LTV_PRECISION(),
      this.lendingPool.REPUTATION_PRECISION(),
      this.lendingPool.REPUTATION_CAP(),
      this.reputationOracle.DECAY_RATE(),
      this.reputationOracle.DECAY_WINDOW(),
      this.reputationOracle.MAX_DECAY_HISTORY(),
      this.reputationOracle.MAX_PROOF_HISTORY(),
      this.reputationOracle.MIN_TASK_VALUE(),
      this.reputationOracle.MAX_TASK_VALUE()
    ]);
    
    return {
      maxConcurrentLoans: Number(maxConcurrentLoans),
      minRepaymentBuffer: Number(minRepaymentBuffer),
      reputationUpdateCooldown: Number(reputationUpdateCooldown),
      identityExpiry: Number(identityExpiry),
      reputationOnTimeRepaymentBonus: Number(reputationOnTimeRepaymentBonus),
      reputationLateRepaymentPenalty: Number(reputationLateRepaymentPenalty),
      reputationDefaultPenalty: Number(reputationDefaultPenalty),
      reputationTaskCompletionBonus: Number(reputationTaskCompletionBonus),
      reputationTaskCompletionPenalty: Number(reputationTaskCompletionPenalty),
      liquidationThreshold: Number(liquidationThreshold),
      liquidationBonus: Number(liquidationBonus),
      minLoanAmount: Number(minLoanAmount),
      maxLoanAmount: Number(maxLoanAmount),
      interestRatePrecision: Number(interestRatePrecision),
      baseInterestRate: Number(baseInterestRate),
      maxLoanDuration: Number(maxLoanDuration),
      minReputationForLoan: Number(minReputationForLoan),
      reputationDecayFactor: Number(reputationDecayFactor),
      maxLTV: Number(maxLTV),
      minLTV: Number(minLTV),
      ltvPrecision: Number(ltvPrecision),
      reputationPrecision: Number(reputationPrecision),
      reputationCap: Number(reputationCap),
      decayRate: Number(decayRate),
      decayWindow: Number(decayWindow),
      maxDecayHistory: Number(maxDecayHistory),
      maxProofHistory: Number(maxProofHistory),
      minTaskValue: Number(minTaskValue),
      maxTaskValue: Number(maxTaskValue)
    };
  }
  
  async _generateTaskProof(taskId, taskData, merkleRoot) {
    const taskHash = ethers.keccak256(
      ethers.solidityPacked(['bytes32', 'bytes'], [taskId, taskData])
    );
    
    const message = ethers.solidityPackedKeccak256(
      ['bytes32', 'bytes32', 'uint256'],
      [taskHash, merkleRoot, Date.now()]
    );
    
    const signature = await this.signer.signMessage(ethers.getBytes(message));
    
    return {
      taskId,
      taskHash,
      merkleRoot,
      timestamp: Date.now(),
      signature
    };
  }
  
  async _verifyTaskProof(proof) {
    const message = ethers.solidityPackedKeccak256(
      ['bytes32', 'bytes32', 'uint256'],
      [proof.taskHash, proof.merkleRoot, proof.timestamp]
    );
    
    const recoveredSigner = ethers.Signature.from(proof.signature).recover(
      ethers.getBytes(message)
    );
    
    return recoveredSigner === this.address;
  }
  
  async _calculateReputationScore(agentAddress) {
    const [
      currentScore,
      lastUpdateBlock,
      totalTasksCompleted
    ] = await Promise.all([
      this.reputationOracle.getAgentReputation(agentAddress),
      this.reputationOracle.getLastUpdateBlock(agentAddress),
      this.reputationOracle.getTotalTasksCompleted(agentAddress)
    ]);
    
    return {
      currentScore: Number(currentScore),
      lastUpdateBlock: Number(lastUpdateBlock),
      totalTasksCompleted: Number(totalTasksCompleted)
    };
  }
  
  async _calculateAgentLTV(agentAddress) {
    const [
      reputationScore,
      activeLoans,
      totalBorrowed,
      totalRepaid
    ] = await Promise.all([
      this.reputationOracle.getAgentReputation(agentAddress),
      this.agentController.getActiveLoanCount(agentAddress),
      this.lendingPool.getTotalBorrowed(agentAddress),
      this.lendingPool.getTotalRepaid(agentAddress)
    ]);
    
    const reputationMultiplier = Number(reputationScore) / 1e18;
    const repaymentRatio = totalRepaid > 0 ? Number(totalRepaid) / Number(totalBorrowed) : 1;
    const ltv = Math.min(
      Number(maxLTV),
      Math.max(
        Number(minLTV),
        Number(maxLTV) * reputationMultiplier * (0.5 + 0.5 * repaymentRatio)
      )
    );
    
    return {
      ltv: Number(ltv),
      reputationMultiplier,
      repaymentRatio,
      activeLoans: Number(activeLoans)
    };
  }
  
  async _calculateLoanCapacity(agentAddress) {
    const { ltv, activeLoans, maxConcurrentLoans } = await this._calculateAgentLTV(agentAddress);
    const totalBorrowed = await this.lendingPool.getTotalBorrowed(agentAddress);
    
    const availableLoans = maxConcurrentLoans - activeLoans;
    const capacity = Number(totalBorrowed) * (ltv / 1e18);
    
    return {
      availableLoans,
      capacity: Number(capacity),
      ltv: Number(ltv)
    };
  }
  
  async requestLoan({ amount, duration, taskProof }) {
    const constants = await this._getContractConstants();
    
    if (amount < constants.minLoanAmount) {
      throw new Error(`Loan amount must be at least ${constants.minLoanAmount}`);
    }
    
    if (amount > constants.maxLoanAmount) {
      throw new Error(`Loan amount cannot exceed ${constants.maxLoanAmount}`);
    }
    
    if (duration > constants.maxLoanDuration) {
      throw new Error(`Loan duration cannot exceed ${constants.maxLoanDuration}`);
    }
    
    const { availableLoans, capacity } = await this._calculateLoanCapacity(this.address);
    
    if (availableLoans <= 0) {
      throw new Error('Maximum concurrent loans reached');
    }
    
    if (amount > capacity) {
      throw new Error(`Loan amount exceeds reputation-backed capacity: ${capacity}`);
    }
    
    if (taskProof) {
      const isValid = await this._verifyTaskProof(taskProof);
      if (!isValid) {
        throw new Error('Invalid task proof signature');
      }
    }
    
    const tx = await this.lendingPool.requestLoan(
      this.address,
      amount,
      duration,
      taskProof ? taskProof.taskId : ethers.ZeroHash
    );
    
    const receipt = await tx.wait();
    
    const loanEvent = receipt.logs.find(log => {
      try {
        const parsed = this.lendingPool.interface.parseLog(log);
        return parsed?.name === 'LoanRequested';
      } catch {
        return false;
      }
    });
    
    if (!loanEvent) {
      throw new Error('Loan request event not found in receipt');
    }
    
    const parsedEvent = this.lendingPool.interface.parseLog(loanEvent);
    
    return {
      success: true,
      loanId: parsedEvent.args.loanId,
      amount: parsedEvent.args.amount,
      duration: parsedEvent.args.duration,
      timestamp: parsedEvent.args.timestamp,
      txHash: receipt.hash
    };
  }
  
  async repayLoan({ loanId, amount }) {
    const constants = await this._getContractConstants();
    
    const loan = await this.lendingPool.getLoan(loanId);
    
    if (loan.borrower !== this.address) {
      throw new Error('Not your loan');
    }
    
    const currentTime = await this.provider.getBlock('latest');
    const repaymentDeadline = Number(loan.interestAccrualStart) + Number(loan.duration);
    
    if (currentTime.timestamp < repaymentDeadline) {
      throw new Error('Loan not yet due for repayment');
    }
    
    const tx = await this.lendingPool.repayLoan(loanId, amount);
    const receipt = await tx.wait();
    
    const repaymentEvent = receipt.logs.find(log => {
      try {
        const parsed = this.lendingPool.interface.parseLog(log);
        return parsed?.name === 'RepaymentMade';
      } catch {
        return false;
      }
    });
    
    if (!repaymentEvent) {
      throw new Error('Repayment event not found in receipt');
    }
    
    const parsedEvent = this.lendingPool.interface.parseLog(repaymentEvent);
    
    return {
      success: true,
      loanId,
      repaidAmount: parsedEvent.args.amount,
      interestPaid: parsedEvent.args.interest,
      reputationBonus: parsedEvent.args.reputationBonus,
      txHash: receipt.hash
    };
  }
  
  async liquidateLoan({ loanId, liquidator }) {
    const loan = await this.lendingPool.getLoan(loanId);
    
    if (loan.borrower !== this.address) {
      throw new Error('Not your loan');
    }
    
    const currentTime = await this.provider.getBlock('latest');
    const repaymentDeadline = Number(loan.interestAccrualStart) + Number(loan.duration);
    
    if (currentTime.timestamp < repaymentDeadline) {
      throw new Error('Loan not yet due for liquidation');
    }
    
    const tx = await this.lendingPool.liquidateLoan(loanId, liquidator);
    const receipt = await tx.wait();
    
    const liquidationEvent = receipt.logs.find(log => {
      try {
        const parsed = this.lendingPool.interface.parseLog(log);
        return parsed?.name === 'LiquidationExecuted';
      } catch {
        return false;
      }
    });
    
    if (!liquidationEvent) {
      throw new Error('Liquidation event not found in receipt');
    }
    
    const parsedEvent = this.lendingPool.interface.parseLog(liquidationEvent);
    
    return {
      success: true,
      loanId,
      liquidator: parsedEvent.args.liquidator,
      liquidationBonus: parsedEvent.args.liquidationBonus,
      reputationPenalty: parsedEvent.args.reputationPenalty,
      txHash: receipt.hash
    };
  }
  
  async submitTaskProof({ taskId, taskData, merkleRoot }) {
    const constants = await this._getContractConstants();
    
    const taskValue = Number(ethers.keccak256(ethers.toUtf8Bytes(taskId))) % 
                      (constants.maxTaskValue - constants.minTaskValue) + 
                      constants.minTaskValue;
    
    const proof = await this._generateTaskProof(taskId, taskData, merkleRoot);
    
    const tx = await this.agentController.submitTaskProof(
      taskId,
      taskValue,
      merkleRoot,
      proof.signature
    );
    
    const receipt = await tx.wait();
    
    const taskProofEvent = receipt.logs.find(log => {
      try {
        const parsed = this.agentController.interface.parseLog(log);
        return parsed?.name === 'TaskProofSubmitted';
      } catch {
        return false;
      }
    });
    
    if (!taskProofEvent) {
      throw new Error('Task proof event not found in receipt');
    }
    
    const parsedEvent = this.agentController.interface.parseLog(taskProofEvent);
    
    return {
      success: true,
      taskId,
      taskValue: Number(parsedEvent.args.taskValue),
      merkleRoot: parsedEvent.args.merkleRoot,
      timestamp: parsedEvent.args.timestamp,
      txHash: receipt.hash
    };
  }
  
  async getAgentStatus() {
    const [
      reputationScore,
      activeLoans,
      totalBorrowed,
      totalRepaid,
      totalTasksCompleted,
      lastReputationUpdate
    ] = await Promise.all([
      this.reputationOracle.getAgentReputation(this.address),
      this.agentController.getActiveLoanCount(this.address),
      this.lendingPool.getTotalBorrowed(this.address),
      this.lendingPool.getTotalRepaid(this.address),
      this.reputationOracle.getTotalTasksCompleted(this.address),
      this.reputationOracle.getLastUpdateBlock(this.address)
    ]);
    
    const { ltv, capacity } = await this._calculateLoanCapacity(this.address);
    
    return {
      address: this.address,
      reputationScore: Number(reputationScore),
      activeLoans: Number(activeLoans),
      totalBorrowed: Number(totalBorrowed),
      totalRepaid: Number(totalRepaid),
      totalTasksCompleted: Number(totalTasksCompleted),
      lastReputationUpdate: Number(lastReputationUpdate),
      ltv: Number(ltv),
      capacity: Number(capacity),
      availableLoans: Number(await this.agentController.MAX_CONCURRENT_LOANS()) - Number(activeLoans)
    };
  }
  
  async getLoanDetails(loanId) {
    const loan = await this.lendingPool.getLoan(loanId);
    
    const currentTime = await this.provider.getBlock('latest');
    const repaymentDeadline = Number(loan.interestAccrualStart) + Number(loan.duration);
    const timeRemaining = Math.max(0, repaymentDeadline - currentTime.timestamp);
    
    const interestAccrued = Number(loan.principal) * 
      Number(loan.interestAccrualStart) * 
      Number(loan.duration) / 
      Number(loan.interestAccrualStart);
    
    return {
      loanId,
      borrower: loan.borrower,
      principal: Number(loan.principal),
      duration: Number(loan.duration),
      interestAccrualStart: Number(loan.interestAccrualStart),
      repaymentDeadline,
      timeRemaining,
      interestAccrued: Number(interestAccrued),
      isOverdue: currentTime.timestamp > repaymentDeadline,
    };
  }
  
  async getReputationHistory() {
    const history = await this.reputationOracle.getReputationHistory(this.address);
    
    return history.map(entry => ({
      blockNumber: Number(entry.blockNumber),
      score: Number(entry.score),
      timestamp: Number(entry.timestamp),
      reason: entry.reason
    }));
  }
  
  async getActiveLoans() {
    const activeLoans = await this.agentController.getActiveLoans(this.address);
    
    const loanDetails = await Promise.all(
      activeLoans.map(async (loanId) => {
        const loan = await this.lendingPool.getLoan(loanId);
        return {
          loanId: Number(loanId),
          principal: Number(loan.principal),
          duration: Number(loan.duration),
          status: 'active'
        };
      })
    );
    
    return loanDetails;
  }
  
  async getLiquidationRisk() {
    const { ltv, capacity } = await this._calculateLoanCapacity(this.address);
    const totalBorrowed = await this.lendingPool.getTotalBorrowed(this.address);
    const liquidationThreshold = await this.lendingPool.LIQUIDATION_THRESHOLD();
    
    const riskLevel = ltv > Number(liquidationThreshold) ? 'HIGH' : 
                      ltv > Number(liquidationThreshold) * 0.8 ? 'MEDIUM' : 'LOW';
    
    const buffer = Number(liquidationThreshold) - ltv;
    
    return {
      currentLTV: Number(ltv),
      liquidationThreshold: Number(liquidationThreshold),
      buffer: Number(buffer),
      riskLevel,
      totalBorrowed: Number(totalBorrowed),
      capacity: Number(capacity)
    };
  }
  
  async startEventListeners(callbacks) {
    this.lendingPool.on(this._loanEventFilter, async (loanId, borrower, amount, duration, timestamp, event) => {
      if (callbacks.onLoanRequested) {
        await callbacks.onLoanRequested({
          loanId: Number(loanId),
          borrower,
          amount: Number(amount),
          duration: Number(duration),
          timestamp: Number(timestamp),
          event
        });
      }
    });
    
    this.lendingPool.on(this._repaymentEventFilter, async (loanId, borrower, amount, interest, reputationBonus, event) => {
      if (callbacks.onRepaymentMade) {
        await callbacks.onRepaymentMade({
          loanId: Number(loanId),
          borrower,
          amount: Number(amount),
          interest: Number(interest),
          reputationBonus: Number(reputationBonus),
          event
        });
      }
    });
    
    this.lendingPool.on(this._liquidationEventFilter, async (loanId, borrower, liquidator, liquidationBonus, reputationPenalty, event) => {
      if (callbacks.onLiquidationExecuted) {
        await callbacks.onLiquidationExecuted({
          loanId: Number(loanId),
          borrower,
          liquidator,
          liquidationBonus: Number(liquidationBonus),
          reputationPenalty: Number(reputationPenalty),
          event
        });
      }
    });
    
    this.agentController.on(this._taskProofEventFilter, async (taskId, taskValue, merkleRoot, timestamp, event) => {
      if (callbacks.onTaskProofSubmitted) {
        await callbacks.onTaskProofSubmitted({
          taskId,
          taskValue: Number(taskValue),
          merkleRoot,
          timestamp: Number(timestamp),
          event
        });
      }
    });
    
    return () => {
      this.lendingPool.removeAllListeners(this._loanEventFilter);
      this.lendingPool.removeAllListeners(this._repaymentEventFilter);
      this.lendingPool.removeAllListeners(this._liquidationEventFilter);
      this.agentController.removeAllListeners(this._taskProofEventFilter);
    };
  }
  
  async stopEventListeners() {
    this.lendingPool.removeAllListeners();
    this.agentController.removeAllListeners();
  }
  
  async calculateReputationDecay(currentScore, blocksSinceUpdate) {
    const decayFactor = await this.reputationOracle.DECAY_RATE();
    const decayWindow = await this.reputationOracle.DECAY_WINDOW();
    
    const decayMultiplier = Number(decayFactor) ** (blocksSinceUpdate / Number(decayWindow));
    const decayedScore = Number(currentScore) * decayMultiplier;
    
    return {
      decayedScore: Number(decayedScore),
      decayMultiplier,
      blocksSinceUpdate
    };
  }
  
  async validateLoanEligibility() {
    const constants = await this._getContractConstants();
    const { reputationScore, activeLoans, availableLoans } = await this._calculateLoanCapacity(this.address);
    
    const eligibility = {
      eligible: true,
      reasons: []
    };
    
    if (Number(reputationScore) < Number(constants.minReputationForLoan)) {
      eligibility.eligible = false;
      eligibility.reasons.push('Insufficient reputation score');
    }
    
    if (availableLoans <= 0) {
      eligibility.eligible = false;
      eligibility.reasons.push('Maximum concurrent loans reached');
    }
    
    if (Number(activeLoans) > Number(constants.maxConcurrentLoans)) {
      eligibility.eligible = false;
      eligibility.reasons.push('Exceeds maximum concurrent loans');
    }
    
    return eligibility;
  }
  
  async generateMerkleProof(taskId, merkleRoot) {
    const proof = await this.reputationOracle.generateMerkleProof(taskId, merkleRoot);
    
    return {
      taskId,
      merkleRoot,
      proof,
      timestamp: Date.now()
    };
  }
  
  async verifyMerkleInclusion(taskId, merkleRoot, proof) {
    const isValid = await this.reputationOracle.verifyMerkleInclusion(
      taskId,
      merkleRoot,
      proof
    );
    
    return {
      isValid,
      taskId,
      merkleRoot
    };
  }
  
  async getProtocolHealth() {
    const [
      totalBorrowed,
      totalRepaid,
      totalLoans,
      totalLiquidations,
      averageLTV,
      averageReputation
    ] = await Promise.all([
      this.lendingPool.getTotalBorrowed(),
      this.lendingPool.getTotalRepaid(),
      this.lendingPool.getTotalLoans(),
      this.lendingPool.getTotalLiquidations(),
      this.lendingPool.getAverageLTV(),
      this.reputationOracle.getAverageReputation()
    ]);
    
    const utilizationRate = Number(totalBorrowed) / (Number(totalBorrowed) + Number(totalRepaid));
    const repaymentRate = Number(totalRepaid) / (Number(totalBorrowed) || 1);
    
    return {
      totalBorrowed: Number(totalBorrowed),
      totalRepaid: Number(totalRepaid),
      totalLoans: Number(totalLoans),
      totalLiquidations: Number(totalLiquidations),
      averageLTV: Number(averageLTV),
      averageReputation: Number(averageReputation),
      utilizationRate,
      repaymentRate,
      healthScore: repaymentRate * (1 - utilizationRate)
    };
  }
  
  async simulateLoanScenario({ amount, duration, currentReputation }) {
    const constants = await this._getContractConstants();
    
    const reputationMultiplier = Number(currentReputation) / 1e18;
    const ltv = Math.min(
      Number(constants.maxLTV),
      Number(constants.maxLTV) * reputationMultiplier
    );
    
    const capacity = Number(amount) / (ltv / 1e18);
    const interest = Number(amount) * Number(constants.baseInterestRate) / Number(constants.interestRatePrecision) * duration;
    
    return {
      amount,
      duration,
      currentReputation: Number(currentReputation),
      ltv: Number(ltv),
      capacity: Number(capacity),
      estimatedInterest: Number(interest),
      totalRepayment: Number(amount) + Number(interest),
      eligible: ltv <= Number(constants.liquidationThreshold)
    };
  }
}

export { AgentService };