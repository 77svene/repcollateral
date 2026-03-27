// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title ReputationOracle
 * @notice Cryptographic reputation primitive for autonomous agent lending
 * @dev Reputation is a verifiable credential derived from task completion proofs
 *      with exponential decay and Merkle-inclusion verification
 * @dev Novel primitive: Time-weighted reputation decay with cryptographic task proofs
 */
contract ReputationOracle {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    uint256 public constant REPUTATION_PRECISION = 1e18;
    uint256 public constant DECAY_RATE = 999500000000000000; // 0.9995 per block
    uint256 public constant MIN_TASK_VALUE = 1e18;
    uint256 public constant MAX_TASK_VALUE = 1e24;
    uint256 public constant REPUTATION_CAP = 1e36;
    uint256 public constant DECAY_WINDOW = 10000; // blocks
    uint256 public constant MAX_DECAY_HISTORY = 100;
    uint256 public constant MAX_PROOF_HISTORY = 1000;

    struct TaskProof {
        bytes32 taskId;
        uint256 timestamp;
        uint256 value;
        bytes32 merkleRoot;
        bool verified;
    }

    struct AgentReputation {
        uint256 currentScore;
        uint256 lastUpdateBlock;
        uint256[] decayHistory;
        uint256 decayHistoryIndex;
        uint256 totalTasksCompleted;
        uint256 totalTaskValue;
        bool active;
        uint256[] proofTimestamps;
        uint256 proofHistoryIndex;
    }

    mapping(address => AgentReputation) public agents;
    mapping(bytes32 => TaskProof) public taskProofs;
    mapping(bytes32 => bool) public verifiedTaskIds;
    mapping(address => mapping(bytes32 => bool)) public agentVerifiedTasks;
    mapping(address => bool) public authorizedVerifiers;
    address public verifierRegistry;
    uint256 public totalReputationIssued;
    uint256 public totalTasksVerified;

    event ReputationUpdated(address indexed agent, uint256 newScore, uint256 oldScore, uint256 blockNumber);
    event TaskVerified(bytes32 indexed taskId, address indexed agent, uint256 value, bytes32 merkleRoot);
    event VerifierAuthorized(address indexed verifier, bool authorized);
    event ReputationDecayed(address indexed agent, uint256 decayAmount, uint256 newScore);
    event AgentActivated(address indexed agent, uint256 initialScore);
    event AgentDeactivated(address indexed agent);

    constructor(address _verifierRegistry) {
        verifierRegistry = _verifierRegistry;
        authorizedVerifiers[_verifierRegistry] = true;
    }

    function isVerifier(address _verifier) public view returns (bool) {
        return authorizedVerifiers[_verifier];
    }

    function authorizeVerifier(address _verifier, bool _authorized) external {
        require(msg.sender == verifierRegistry, "Unauthorized");
        authorizedVerifiers[_verifier] = _authorized;
        emit VerifierAuthorized(_verifier, _authorized);
    }

    function registerAgent(address _agent) external returns (bool) {
        require(!agents[_agent].active, "Agent already registered");
        agents[_agent].active = true;
        agents[_agent].currentScore = 1e18; // Base reputation
        agents[_agent].lastUpdateBlock = block.number;
        agents[_agent].totalTasksCompleted = 0;
        agents[_agent].totalTaskValue = 0;
        emit AgentActivated(_agent, 1e18);
        return true;
    }

    function updateReputation(address _agent, uint256 _newScore) external {
        require(agents[_agent].active, "Agent not active");
        require(_newScore <= REPUTATION_CAP, "Score exceeds cap");
        
        uint256 oldScore = agents[_agent].currentScore;
        agents[_agent].currentScore = _newScore;
        agents[_agent].lastUpdateBlock = block.number;
        
        totalReputationIssued += (_newScore > oldScore) ? (_newScore - oldScore) : 0;
        
        emit ReputationUpdated(_agent, _newScore, oldScore, block.number);
    }

    function applyExponentialDecay(address _agent) external returns (uint256) {
        require(agents[_agent].active, "Agent not active");
        
        uint256 blocksSinceUpdate = block.number - agents[_agent].lastUpdateBlock;
        if (blocksSinceUpdate == 0) {
            return agents[_agent].currentScore;
        }
        
        uint256 decayFactor = calculateDecayFactor(blocksSinceUpdate);
        uint256 oldScore = agents[_agent].currentScore;
        uint256 newScore = (oldScore * decayFactor) / REPUTATION_PRECISION;
        
        if (newScore < oldScore) {
            uint256 decayAmount = oldScore - newScore;
            agents[_agent].currentScore = newScore;
            agents[_agent].lastUpdateBlock = block.number;
            
            if (agents[_agent].decayHistory.length < MAX_DECAY_HISTORY) {
                agents[_agent].decayHistory.push(decayAmount);
            }
            
            emit ReputationDecayed(_agent, decayAmount, newScore);
        }
        
        return newScore;
    }

    function calculateDecayFactor(uint256 _blocks) internal view returns (uint256) {
        if (_blocks == 0) return REPUTATION_PRECISION;
        
        uint256 decayFactor = REPUTATION_PRECISION;
        uint256 blocksToApply = _blocks;
        
        while (blocksToApply > 0 && decayFactor > 0) {
            uint256 applyBlocks = blocksToApply > 1000 ? 1000 : blocksToApply;
            uint256 factorPerBlock = DECAY_RATE;
            
            for (uint256 i = 0; i < applyBlocks; i++) {
                decayFactor = (decayFactor * factorPerBlock) / REPUTATION_PRECISION;
            }
            
            blocksToApply -= applyBlocks;
        }
        
        return decayFactor;
    }

    function submitTaskProof(
        address _agent,
        bytes32 _taskId,
        uint256 _value,
        bytes32 _merkleRoot,
        bytes calldata _signature
    ) external returns (bool) {
        require(agents[_agent].active, "Agent not active");
        require(_value >= MIN_TASK_VALUE && _value <= MAX_TASK_VALUE, "Invalid task value");
        require(!verifiedTaskIds[_taskId], "Task already verified");
        
        bytes32 messageHash = keccak256(
            abi.encodePacked(_taskId, _agent, _value, block.number)
        );
        
        address signer = messageHash.recover(_signature);
        require(authorizedVerifiers[signer], "Unauthorized verifier");
        
        taskProofs[_taskId] = TaskProof({
            taskId: _taskId,
            timestamp: block.timestamp,
            value: _value,
            merkleRoot: _merkleRoot,
            verified: true
        });
        
        verifiedTaskIds[_taskId] = true;
        agentVerifiedTasks[_agent][_taskId] = true;
        
        uint256 oldScore = agents[_agent].currentScore;
        uint256 newScore = (oldScore + _value) > REPUTATION_CAP 
            ? REPUTATION_CAP 
            : (oldScore + _value);
        
        agents[_agent].currentScore = newScore;
        agents[_agent].lastUpdateBlock = block.number;
        agents[_agent].totalTasksCompleted += 1;
        agents[_agent].totalTaskValue += _value;
        
        if (agents[_agent].proofTimestamps.length < MAX_PROOF_HISTORY) {
            agents[_agent].proofTimestamps.push(block.timestamp);
        }
        
        totalTasksVerified += 1;
        
        emit TaskVerified(_taskId, _agent, _value, _merkleRoot);
        emit ReputationUpdated(_agent, newScore, oldScore, block.number);
        
        return true;
    }

    function verifyTaskWithMerkle(
        address _agent,
        bytes32 _taskId,
        bytes32[] calldata _proof,
        uint256 _value,
        bytes calldata _signature
    ) external returns (bool) {
        require(agents[_agent].active, "Agent not active");
        require(_value >= MIN_TASK_VALUE && _value <= MAX_TASK_VALUE, "Invalid task value");
        require(!verifiedTaskIds[_taskId], "Task already verified");
        
        bytes32 leaf = keccak256(abi.encodePacked(_taskId, _value, block.number));
        bytes32 computedRoot = computeMerkleRoot(_proof, leaf);
        
        require(computedRoot == taskProofs[_taskId].merkleRoot, "Invalid merkle proof");
        
        bytes32 messageHash = keccak256(
            abi.encodePacked(_taskId, _agent, _value, block.number)
        );
        
        address signer = messageHash.recover(_signature);
        require(authorizedVerifiers[signer], "Unauthorized verifier");
        
        verifiedTaskIds[_taskId] = true;
        agentVerifiedTasks[_agent][_taskId] = true;
        
        uint256 oldScore = agents[_agent].currentScore;
        uint256 newScore = (oldScore + _value) > REPUTATION_CAP 
            ? REPUTATION_CAP 
            : (oldScore + _value);
        
        agents[_agent].currentScore = newScore;
        agents[_agent].lastUpdateBlock = block.number;
        agents[_agent].totalTasksCompleted += 1;
        agents[_agent].totalTaskValue += _value;
        
        if (agents[_agent].proofTimestamps.length < MAX_PROOF_HISTORY) {
            agents[_agent].proofTimestamps.push(block.timestamp);
        }
        
        totalTasksVerified += 1;
        
        emit TaskVerified(_taskId, _agent, _value, taskProofs[_taskId].merkleRoot);
        emit ReputationUpdated(_agent, newScore, oldScore, block.number);
        
        return true;
    }

    function computeMerkleRoot(bytes32[] calldata _proof, bytes32 _leaf) internal pure returns (bytes32) {
        bytes32 currentHash = _leaf;
        
        for (uint256 i = 0; i < _proof.length; i++) {
            if (i % 2 == 0) {
                currentHash = keccak256(abi.encodePacked(currentHash, _proof[i]));
            } else {
                currentHash = keccak256(abi.encodePacked(_proof[i], currentHash));
            }
        }
        
        return currentHash;
    }

    function getAgentReputation(address _agent) external view returns (
        uint256 currentScore,
        uint256 lastUpdateBlock,
        uint256 totalTasksCompleted,
        uint256 totalTaskValue,
        bool active
    ) {
        AgentReputation storage agent = agents[_agent];
        return (
            agent.currentScore,
            agent.lastUpdateBlock,
            agent.totalTasksCompleted,
            agent.totalTaskValue,
            agent.active
        );
    }

    function getTaskProof(bytes32 _taskId) external view returns (
        bytes32 taskId,
        uint256 timestamp,
        uint256 value,
        bytes32 merkleRoot,
        bool verified
    ) {
        TaskProof storage proof = taskProofs[_taskId];
        return (
            proof.taskId,
            proof.timestamp,
            proof.value,
            proof.merkleRoot,
            proof.verified
        );
    }

    function isTaskVerified(bytes32 _taskId) external view returns (bool) {
        return verifiedTaskIds[_taskId];
    }

    function isAgentVerifiedTask(address _agent, bytes32 _taskId) external view returns (bool) {
        return agentVerifiedTasks[_agent][_taskId];
    }

    function getAgentProofHistory(address _agent) external view returns (uint256[] memory) {
        return agents[_agent].proofTimestamps;
    }

    function getAgentDecayHistory(address _agent) external view returns (uint256[] memory) {
        return agents[_agent].decayHistory;
    }

    function deactivateAgent(address _agent) external {
        require(agents[_agent].active, "Agent not active");
        agents[_agent].active = false;
        emit AgentDeactivated(_agent);
    }

    function getAgentScoreWithDecay(address _agent) external view returns (uint256) {
        AgentReputation storage agent = agents[_agent];
        if (!agent.active) return 0;
        
        uint256 blocksSinceUpdate = block.number - agent.lastUpdateBlock;
        if (blocksSinceUpdate == 0) return agent.currentScore;
        
        uint256 decayFactor = calculateDecayFactor(blocksSinceUpdate);
        return (agent.currentScore * decayFactor) / REPUTATION_PRECISION;
    }

    function getLTVBasedOnReputation(address _agent) external view returns (uint256) {
        uint256 reputationScore = getAgentScoreWithDecay(_agent);
        if (reputationScore == 0) return 0;
        
        uint256 baseLTV = 5000; // 50% base LTV
        uint256 reputationMultiplier = (reputationScore * 10000) / REPUTATION_PRECISION;
        uint256 dynamicLTV = (baseLTV * reputationMultiplier) / 10000;
        
        return dynamicLTV > 8000 ? 8000 : dynamicLTV; // Max 80% LTV
    }

    function getRiskScore(address _agent) external view returns (uint256) {
        AgentReputation storage agent = agents[_agent];
        if (!agent.active) return 10000; // 100% risk
        
        uint256 reputationScore = agent.currentScore;
        uint256 taskCount = agent.totalTasksCompleted;
        uint256 blocksSinceUpdate = block.number - agent.lastUpdateBlock;
        
        uint256 reputationFactor = (reputationScore * 5000) / REPUTATION_PRECISION;
        uint256 taskFactor = taskCount > 100 ? 5000 : (taskCount * 50);
        uint256 recencyFactor = blocksSinceUpdate > DECAY_WINDOW ? 0 : (10000 - (blocksSinceUpdate * 10000 / DECAY_WINDOW));
        
        uint256 riskScore = 10000 - (reputationFactor + taskFactor + recencyFactor);
        return riskScore > 10000 ? 10000 : riskScore;
    }

    function getProtocolStats() external view returns (
        uint256 totalReputation,
        uint256 totalTasks,
        uint256 totalAgents
    ) {
        totalReputation = totalReputationIssued;
        totalTasks = totalTasksVerified;
        
        uint256 agentCount = 0;
        for (uint256 i = 0; i < 1000; i++) {
            // Limit iteration for gas efficiency
            // In production, use a mapping of active agents
        }
        
        return (totalReputation, totalTasks, agentCount);
    }
}