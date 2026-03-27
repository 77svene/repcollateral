// SPDX-License-Identifier: MIT
import { expect } from "chai";
import { ethers } from "hardhat";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

describe("ReputationOracle", function () {
  let reputationOracle;
  let lendingPool;
  let agentController;
  let owner, agent1, agent2, agent3, attacker;
  let testAsset;

  const REPUTATION_PRECISION = ethers.BigNumber.from("1000000000000000000");
  const DECAY_RATE = ethers.BigNumber.from("999500000000000000");
  const REPUTATION_CAP = ethers.BigNumber.from("1000000000000000000000000000000000000");

  beforeEach(async function () {
    [owner, agent1, agent2, agent3, attacker] = await ethers.getSigners();

    const ReputationOracle = await ethers.getContractFactory("ReputationOracle");
    reputationOracle = await ReputationOracle.deploy(owner.address);
    await reputationOracle.deployed();

    const LendingPool = await ethers.getContractFactory("LendingPool");
    lendingPool = await LendingPool.deploy(owner.address, reputationOracle.address);
    await lendingPool.deployed();

    const AgentController = await ethers.getContractFactory("AgentController");
    agentController = await AgentController.deploy(
      owner.address,
      lendingPool.address,
      reputationOracle.address
    );
    await agentController.deployed();

    const TestAsset = await ethers.getContractFactory("TestERC20");
    testAsset = await TestAsset.deploy();
    await testAsset.deployed();

    await testAsset.mint(agent1.address, ethers.utils.parseEther("1000"));
    await testAsset.mint(agent2.address, ethers.utils.parseEther("1000"));
    await testAsset.mint(agent3.address, ethers.utils.parseEther("1000"));
    await testAsset.mint(attacker.address, ethers.utils.parseEther("1000"));

    await testAsset.approve(lendingPool.address, ethers.utils.parseEther("10000"));
    await lendingPool.setAsset(testAsset.address);
  });

  describe("Reputation Scoring", function () {
    it("should initialize agent with base reputation", async function () {
      const tx = await agentController.registerAgent(
        agent1.address,
        "0x" + "1234".repeat(32)
      );
      const receipt = await tx.wait();
      const event = receipt.events.find(e => e.event === "AgentRegistered");
      expect(event.args.agent).to.equal(agent1.address);
    });

    it("should calculate reputation correctly after task completion", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const merkleProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1")),
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-2"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.concat([
          ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1")),
          ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-2"))
        ])
      );

      const tx = await reputationOracle.submitTaskProof(
        agent1.address,
        taskId,
        ethers.utils.parseEther("100"),
        merkleRoot,
        merkleProof
      );
      const receipt = await tx.wait();
      const event = receipt.events.find(e => e.event === "TaskProofVerified");
      expect(event.args.agent).to.equal(agent1.address);
      expect(event.args.value).to.equal(ethers.utils.parseEther("100"));
    });

    it("should reject invalid merkle proofs", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const invalidProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("wrong-leaf"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.concat([
          ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1")),
          ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-2"))
        ])
      );

      await expect(
        reputationOracle.submitTaskProof(
          agent1.address,
          taskId,
          ethers.utils.parseEther("100"),
          merkleRoot,
          invalidProof
        )
      ).to.be.reverted;
    });

    it("should cap reputation at maximum value", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      for (let i = 0; i < 1000; i++) {
        const taskId = ethers.utils.keccak256(
          ethers.utils.toUtf8Bytes(`test-task-${i}`)
        );
        const merkleProof = [
          ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`leaf-${i}`))
        ];
        const merkleRoot = ethers.utils.keccak256(
          ethers.utils.toUtf8Bytes(`leaf-${i}`)
        );

        await reputationOracle.submitTaskProof(
          agent1.address,
          taskId,
          ethers.utils.parseEther("1000"),
          merkleRoot,
          merkleProof
        );
      }

      const reputation = await reputationOracle.getAgentReputation(agent1.address);
      expect(reputation.currentScore).to.be.at.most(REPUTATION_CAP);
    });

    it("should track decay history correctly", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const merkleProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("leaf-1")
      );

      await reputationOracle.submitTaskProof(
        agent1.address,
        taskId,
        ethers.utils.parseEther("100"),
        merkleRoot,
        merkleProof
      );

      const reputation = await reputationOracle.getAgentReputation(agent1.address);
      expect(reputation.decayHistory.length).to.be.greaterThan(0);
    });
  });

  describe("Reputation Decay", function () {
    it("should decay reputation over time", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const merkleProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("leaf-1")
      );

      await reputationOracle.submitTaskProof(
        agent1.address,
        taskId,
        ethers.utils.parseEther("100"),
        merkleRoot,
        merkleProof
      );

      const initialReputation = await reputationOracle.getAgentReputation(agent1.address);
      
      // Advance blocks to trigger decay
      for (let i = 0; i < 100; i++) {
        await ethers.provider.send("evm_increaseTime", [1000]);
        await ethers.provider.send("evm_mine", []);
      }

      const decayedReputation = await reputationOracle.getAgentReputation(agent1.address);
      expect(decayedReputation.currentScore).to.be.lessThan(initialReputation.currentScore);
    });

    it("should not decay below minimum threshold", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const merkleProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("leaf-1")
      );

      await reputationOracle.submitTaskProof(
        agent1.address,
        taskId,
        ethers.utils.parseEther("100"),
        merkleRoot,
        merkleProof
      );

      // Advance many blocks
      for (let i = 0; i < 10000; i++) {
        await ethers.provider.send("evm_increaseTime", [1000]);
        await ethers.provider.send("evm_mine", []);
      }

      const reputation = await reputationOracle.getAgentReputation(agent1.address);
      expect(reputation.currentScore).to.be.greaterThan(ethers.utils.parseEther("0.1"));
    });
  });

  describe("Agent Management", function () {
    it("should register new agents", async function () {
      const tx = await agentController.registerAgent(
        agent2.address,
        "0x" + "5678".repeat(32)
      );
      const receipt = await tx.wait();
      const event = receipt.events.find(e => e.event === "AgentRegistered");
      expect(event.args.agent).to.equal(agent2.address);
    });

    it("should prevent duplicate registration", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      await expect(
        agentController.registerAgent(agent1.address, "0x" + "5678".repeat(32))
      ).to.be.reverted;
    });

    it("should update agent reputation on repayment", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const merkleProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("leaf-1")
      );

      await reputationOracle.submitTaskProof(
        agent1.address,
        taskId,
        ethers.utils.parseEther("100"),
        merkleRoot,
        merkleProof
      );

      const initialReputation = await reputationOracle.getAgentReputation(agent1.address);
      
      await agentController.updateReputationOnRepayment(agent1.address);
      
      const updatedReputation = await reputationOracle.getAgentReputation(agent1.address);
      expect(updatedReputation.currentScore).to.be.greaterThan(initialReputation.currentScore);
    });

    it("should penalize reputation on default", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const merkleProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("leaf-1")
      );

      await reputationOracle.submitTaskProof(
        agent1.address,
        taskId,
        ethers.utils.parseEther("100"),
        merkleRoot,
        merkleProof
      );

      const initialReputation = await reputationOracle.getAgentReputation(agent1.address);
      
      await agentController.updateReputationOnDefault(agent1.address);
      
      const penalizedReputation = await reputationOracle.getAgentReputation(agent1.address);
      expect(penalizedReputation.currentScore).to.be.lessThan(initialReputation.currentScore);
    });
  });

  describe("Security", function () {
    it("should prevent unauthorized reputation updates", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const merkleProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("leaf-1")
      );

      await expect(
        reputationOracle.submitTaskProof(
          agent2.address,
          taskId,
          ethers.utils.parseEther("100"),
          merkleRoot,
          merkleProof
        )
      ).to.be.reverted;
    });

    it("should prevent merkle proof forgery", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const fakeProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("fake-leaf"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("fake-root")
      );

      await expect(
        reputationOracle.submitTaskProof(
          agent1.address,
          taskId,
          ethers.utils.parseEther("100"),
          merkleRoot,
          fakeProof
        )
      ).to.be.reverted;
    });

    it("should prevent reputation manipulation via replay attacks", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const merkleProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("leaf-1")
      );

      await reputationOracle.submitTaskProof(
        agent1.address,
        taskId,
        ethers.utils.parseEther("100"),
        merkleRoot,
        merkleProof
      );

      await expect(
        reputationOracle.submitTaskProof(
          agent1.address,
          taskId,
          ethers.utils.parseEther("100"),
          merkleRoot,
          merkleProof
        )
      ).to.be.reverted;
    });
  });
});

describe("LendingPool", function () {
  let reputationOracle;
  let lendingPool;
  let agentController;
  let owner, agent1, agent2, attacker;
  let testAsset;

  const REPUTATION_PRECISION = ethers.BigNumber.from("1000000000000000000");
  const LIQUIDATION_THRESHOLD = ethers.BigNumber.from("700000000000000000");
  const LIQUIDATION_BONUS = ethers.BigNumber.from("50000000000000000");
  const MAX_LTV = ethers.BigNumber.from("900000000000000000");
  const MIN_LTV = ethers.BigNumber.from("100000000000000000");
  const BASE_INTEREST_RATE = ethers.BigNumber.from("150000000000000000");

  beforeEach(async function () {
    [owner, agent1, agent2, attacker] = await ethers.getSigners();

    const ReputationOracle = await ethers.getContractFactory("ReputationOracle");
    reputationOracle = await ReputationOracle.deploy(owner.address);
    await reputationOracle.deployed();

    const LendingPool = await ethers.getContractFactory("LendingPool");
    lendingPool = await LendingPool.deploy(owner.address, reputationOracle.address);
    await lendingPool.deployed();

    const AgentController = await ethers.getContractFactory("AgentController");
    agentController = await AgentController.deploy(
      owner.address,
      lendingPool.address,
      reputationOracle.address
    );
    await agentController.deployed();

    const TestAsset = await ethers.getContractFactory("TestERC20");
    testAsset = await TestAsset.deploy();
    await testAsset.deployed();

    await testAsset.mint(agent1.address, ethers.utils.parseEther("1000"));
    await testAsset.mint(agent2.address, ethers.utils.parseEther("1000"));
    await testAsset.mint(attacker.address, ethers.utils.parseEther("1000"));

    await testAsset.approve(lendingPool.address, ethers.utils.parseEther("10000"));
    await lendingPool.setAsset(testAsset.address);
  });

  describe("LTV Calculations", function () {
    it("should calculate LTV based on reputation", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const merkleProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("leaf-1")
      );

      await reputationOracle.submitTaskProof(
        agent1.address,
        taskId,
        ethers.utils.parseEther("100"),
        merkleRoot,
        merkleProof
      );

      const ltv = await lendingPool.getAgentLTV(agent1.address);
      expect(ltv).to.be.greaterThan(MIN_LTV);
      expect(ltv).to.be.at.most(MAX_LTV);
    });

    it("should return minimum LTV for new agents", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const ltv = await lendingPool.getAgentLTV(agent1.address);
      expect(ltv).to.be.at.least(MIN_LTV);
    });

    it("should calculate LTV correctly for high reputation agents", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      for (let i = 0; i < 100; i++) {
        const taskId = ethers.utils.keccak256(
          ethers.utils.toUtf8Bytes(`test-task-${i}`)
        );
        const merkleProof = [
          ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`leaf-${i}`))
        ];
        const merkleRoot = ethers.utils.keccak256(
          ethers.utils.toUtf8Bytes(`leaf-${i}`)
        );

        await reputationOracle.submitTaskProof(
          agent1.address,
          taskId,
          ethers.utils.parseEther("1000"),
          merkleRoot,
          merkleProof
        );
      }

      const ltv = await lendingPool.getAgentLTV(agent1.address);
      expect(ltv).to.be.closeTo(MAX_LTV, ethers.utils.parseEther("0.05"));
    });

    it("should calculate LTV correctly for low reputation agents", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const ltv = await lendingPool.getAgentLTV(agent1.address);
      expect(ltv).to.be.closeTo(MIN_LTV, ethers.utils.parseEther("0.05"));
    });

    it("should update LTV after reputation changes", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const initialLTV = await lendingPool.getAgentLTV(agent1.address);
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const merkleProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("leaf-1")
      );

      await reputationOracle.submitTaskProof(
        agent1.address,
        taskId,
        ethers.utils.parseEther("100"),
        merkleRoot,
        merkleProof
      );

      const updatedLTV = await lendingPool.getAgentLTV(agent1.address);
      expect(updatedLTV).to.be.greaterThan(initialLTV);
    });
  });

  describe("Loan Management", function () {
    it("should allow agents to borrow based on reputation", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const merkleProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("leaf-1")
      );

      await reputationOracle.submitTaskProof(
        agent1.address,
        taskId,
        ethers.utils.parseEther("100"),
        merkleRoot,
        merkleProof
      );

      const loanAmount = ethers.utils.parseEther("10");
      const tx = await lendingPool.borrow(loanAmount);
      const receipt = await tx.wait();
      const event = receipt.events.find(e => e.event === "LoanTaken");
      expect(event.args.agent).to.equal(agent1.address);
      expect(event.args.amount).to.equal(loanAmount);
    });

    it("should reject loans above LTV limit", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const loanAmount = ethers.utils.parseEther("1000");
      
      await expect(lendingPool.borrow(loanAmount)).to.be.reverted;
    });

    it("should reject loans below minimum amount", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const loanAmount = ethers.utils.parseEther("0.001");
      
      await expect(lendingPool.borrow(loanAmount)).to.be.reverted;
    });

    it("should track loan duration correctly", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const merkleProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("leaf-1")
      );

      await reputationOracle.submitTaskProof(
        agent1.address,
        taskId,
        ethers.utils.parseEther("100"),
        merkleRoot,
        merkleProof
      );

      const loanAmount = ethers.utils.parseEther("10");
      await lendingPool.borrow(loanAmount);
      
      const loan = await lendingPool.getLoan(agent1.address);
      expect(loan.startTime).to.be.greaterThan(0);
    });

    it("should calculate interest correctly", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const merkleProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("leaf-1")
      );

      await reputationOracle.submitTaskProof(
        agent1.address,
        taskId,
        ethers.utils.parseEther("100"),
        merkleRoot,
        merkleProof
      );

      const loanAmount = ethers.utils.parseEther("10");
      await lendingPool.borrow(loanAmount);
      
      await ethers.provider.send("evm_increaseTime", [86400]);
      await ethers.provider.send("evm_mine", []);
      
      const loan = await lendingPool.getLoan(agent1.address);
      const expectedInterest = loanAmount.mul(BASE_INTEREST_RATE).div(REPUTATION_PRECISION);
      expect(loan.totalOwed).to.be.greaterThan(loanAmount);
    });
  });

  describe("Repayment", function () {
    it("should allow agents to repay loans", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const merkleProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("leaf-1")
      );

      await reputationOracle.submitTaskProof(
        agent1.address,
        taskId,
        ethers.utils.parseEther("100"),
        merkleRoot,
        merkleProof
      );

      const loanAmount = ethers.utils.parseEther("10");
      await lendingPool.borrow(loanAmount);
      
      const loan = await lendingPool.getLoan(agent1.address);
      const repaymentAmount = loan.totalOwed;
      
      await testAsset.approve(lendingPool.address, repaymentAmount);
      await lendingPool.repay(loanAmount);
      
      const updatedLoan = await lendingPool.getLoan(agent1.address);
      expect(updatedLoan.principal).to.equal(0);
    });

    it("should reject partial repayments", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const merkleProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("leaf-1")
      );

      await reputationOracle.submitTaskProof(
        agent1.address,
        taskId,
        ethers.utils.parseEther("100"),
        merkleRoot,
        merkleProof
      );

      const loanAmount = ethers.utils.parseEther("10");
      await lendingPool.borrow(loanAmount);
      
      const partialRepayment = loanAmount.div(2);
      await testAsset.approve(lendingPool.address, partialRepayment);
      
      await expect(lendingPool.repay(partialRepayment)).to.be.reverted;
    });

    it("should update reputation on successful repayment", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const merkleProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("leaf-1")
      );

      await reputationOracle.submitTaskProof(
        agent1.address,
        taskId,
        ethers.utils.parseEther("100"),
        merkleRoot,
        merkleProof
      );

      const loanAmount = ethers.utils.parseEther("10");
      await lendingPool.borrow(loanAmount);
      
      const initialReputation = await reputationOracle.getAgentReputation(agent1.address);
      
      const loan = await lendingPool.getLoan(agent1.address);
      const repaymentAmount = loan.totalOwed;
      
      await testAsset.approve(lendingPool.address, repaymentAmount);
      await lendingPool.repay(loanAmount);
      
      const updatedReputation = await reputationOracle.getAgentReputation(agent1.address);
      expect(updatedReputation.currentScore).to.be.greaterThan(initialReputation.currentScore);
    });

    it("should reject repayments after loan maturity", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const merkleProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("leaf-1")
      );

      await reputationOracle.submitTaskProof(
        agent1.address,
        taskId,
        ethers.utils.parseEther("100"),
        merkleRoot,
        merkleProof
      );

      const loanAmount = ethers.utils.parseEther("10");
      await lendingPool.borrow(loanAmount);
      
      await ethers.provider.send("evm_increaseTime", [31 * 86400]);
      await ethers.provider.send("evm_mine", []);
      
      const loan = await lendingPool.getLoan(agent1.address);
      const repaymentAmount = loan.totalOwed;
      
      await testAsset.approve(lendingPool.address, repaymentAmount);
      
      await expect(lendingPool.repay(loanAmount)).to.be.reverted;
    });
  });

  describe("Liquidation", function () {
    it("should trigger liquidation when LTV exceeds threshold", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const merkleProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("leaf-1")
      );

      await reputationOracle.submitTaskProof(
        agent1.address,
        taskId,
        ethers.utils.parseEther("100"),
        merkleRoot,
        merkleProof
      );

      const loanAmount = ethers.utils.parseEther("10");
      await lendingPool.borrow(loanAmount);
      
      // Advance time to increase interest
      await ethers.provider.send("evm_increaseTime", [30 * 86400]);
      await ethers.provider.send("evm_mine", []);
      
      const loan = await lendingPool.getLoan(agent1.address);
      const ltv = await lendingPool.getAgentLTV(agent1.address);
      
      const debtToAssetRatio = loan.totalOwed.div(loanAmount);
      expect(debtToAssetRatio).to.be.greaterThan(LIQUIDATION_THRESHOLD);
    });

    it("should allow liquidators to claim liquidation bonus", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const merkleProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("leaf-1")
      );

      await reputationOracle.submitTaskProof(
        agent1.address,
        taskId,
        ethers.utils.parseEther("100"),
        merkleRoot,
        merkleProof
      );

      const loanAmount = ethers.utils.parseEther("10");
      await lendingPool.borrow(loanAmount);
      
      await ethers.provider.send("evm_increaseTime", [30 * 86400]);
      await ethers.provider.send("evm_mine", []);
      
      const loan = await lendingPool.getLoan(agent1.address);
      const liquidationAmount = loan.totalOwed.mul(LIQUIDATION_BONUS).div(REPUTATION_PRECISION);
      
      await testAsset.approve(lendingPool.address, liquidationAmount);
      await lendingPool.liquidate(agent1.address);
      
      const updatedLoan = await lendingPool.getLoan(agent1.address);
      expect(updatedLoan.principal).to.equal(0);
    });

    it("should prevent liquidation of healthy loans", async function () {
      await agentController.registerAgent(agent1.address, "0x" + "1234".repeat(32));
      
      const taskId = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("test-task-1")
      );
      const merkleProof = [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("leaf-1"))
      ];
      const merkleRoot = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes("leaf-1")
      );

      await reputationOracle.submitTaskProof(
        agent1.address,
        taskId,
        ethers.utils.parseEther("100"),
        merkleRoot,
        merkleProof
      );

      const loanAmount = ethers.utils.parseEther("10");
      await lendingPool.borrow(loanAmount);
      
      await expect(lendingPool.liquidate(agent1.address)).to.be.reverted;
    });

    it("should penalize reputation on liquidation", async function () {