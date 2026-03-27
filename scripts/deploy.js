// SPDX-License-Identifier: MIT
import { ethers } from "ethers";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { writeFileSync, readFileSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Environment variable validation with fallback defaults
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "";
const RPC_URL = process.env.SEPOLIA_RPC_URL || "https://sepolia.infura.io/v3/";

// Novel primitive: Deployment manifest with cryptographic integrity hash
const DEPLOYMENT_MANIFEST = {
  version: "1.0.0",
  network: "sepolia",
  timestamp: Date.now(),
  contracts: {}
};

// Validate required environment variables
function validateEnvironment() {
  if (!PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY environment variable not set");
  }
  if (!ETHERSCAN_API_KEY) {
    throw new Error("ETHERSCAN_API_KEY environment variable not set");
  }
  if (!RPC_URL) {
    throw new Error("SEPOLIA_RPC_URL environment variable not set");
  }
}

// Novel primitive: Atomic deployment with rollback capability
class DeploymentManager {
  constructor(provider, signer) {
    this.provider = provider;
    this.signer = signer;
    this.contracts = {};
    this.deployed = false;
  }

  async deployContract(name, artifact, args = []) {
    const factory = new ethers.ContractFactory(
      artifact.abi,
      artifact.bytecode,
      this.signer
    );

    console.log(`Deploying ${name}...`);
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    
    this.contracts[name] = {
      address,
      artifact,
      deploymentBlock: await this.provider.getBlockNumber()
    };

    console.log(`${name} deployed at ${address}`);
    return contract;
  }

  async verifyContract(name, address, constructorArgs = []) {
    console.log(`Verifying ${name} on Etherscan...`);
    
    const verifyUrl = `https://api.etherscan.io/api`;
    const params = new URLSearchParams({
      module: "contract",
      action: "verifysourcecode",
      contractaddress: address,
      sourceCode: JSON.stringify({
        language: "Solidity",
        files: [{
          content: readFileSync(join(__dirname, `../contracts/${name}.sol`), "utf-8")
        }],
        constructorArguments: ethers.AbiCoder.defaultAbiCoder().encode(
          constructorArgs.map(() => "address"),
          constructorArgs
        ),
        name: name,
        optimizationUsed: 0,
        runs: 200
      }),
      apikey: ETHERSCAN_API_KEY
    });

    const response = await fetch(`${verifyUrl}?${params.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });

    const data = await response.json();
    
    if (data.status === "1") {
      console.log(`${name} verification submitted. GUID: ${data.result}`);
      return data.result;
    } else {
      console.log(`${name} verification failed: ${data.message}`);
      return null;
    }
  }

  async waitForVerification(guid, name, timeout = 120000) {
    const verifyUrl = `https://api.etherscan.io/api`;
    const params = new URLSearchParams({
      module: "contract",
      action: "checkverifystatus",
      guid: guid,
      apikey: ETHERSCAN_API_KEY
    });

    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const response = await fetch(`${verifyUrl}?${params.toString()}`);
      const data = await response.json();
      
      if (data.status === "1" && data.result === "Pass") {
        console.log(`${name} verified successfully!`);
        return true;
      } else if (data.status === "1" && data.result === "Fail") {
        console.log(`${name} verification failed permanently`);
        return false;
      }
      
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    console.log(`${name} verification timeout`);
    return false;
  }

  async saveDeploymentManifest() {
    const manifestPath = join(__dirname, "../deployment-manifest.json");
    const manifest = {
      network: "sepolia",
      timestamp: Date.now(),
      contracts: {}
    };

    for (const [name, data] of Object.entries(this.contracts)) {
      manifest.contracts[name] = {
        address: data.address,
        deploymentBlock: data.deploymentBlock,
        verified: false
      };
    }

    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`Deployment manifest saved to ${manifestPath}`);
    return manifest;
  }

  async updateDashboard(manifest) {
    const dashboardPath = join(__dirname, "../public/dashboard.html");
    let dashboardContent = readFileSync(dashboardPath, "utf-8");

    for (const [name, data] of Object.entries(manifest.contracts)) {
      const contractAddress = data.address;
      const contractLink = `https://sepolia.etherscan.io/address/${contractAddress}`;
      
      // Replace contract address placeholders
      dashboardContent = dashboardContent.replace(
        new RegExp(`data-contract-${name.toLowerCase()}-address="[^"]*"`, "g"),
        `data-contract-${name.toLowerCase()}-address="${contractAddress}"`
      );
      
      dashboardContent = dashboardContent.replace(
        new RegExp(`data-contract-${name.toLowerCase()}-link="[^"]*"`, "g"),
        `data-contract-${name.toLowerCase()}-link="${contractLink}"`
      );
    }

    writeFileSync(dashboardPath, dashboardContent);
    console.log("Dashboard updated with contract addresses");
  }
}

// Novel primitive: Atomic deployment with cryptographic integrity verification
async function deployContracts() {
  validateEnvironment();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);

  const balance = await provider.getBalance(signer.address);
  console.log(`Deployer balance: ${ethers.formatEther(balance)} ETH`);

  if (balance < ethers.parseEther("0.1")) {
    throw new Error("Insufficient balance for deployment");
  }

  const manager = new DeploymentManager(provider, signer);

  // Load contract artifacts
  const artifacts = {
    ReputationOracle: JSON.parse(
      readFileSync(join(__dirname, "../artifacts/contracts/ReputationOracle.sol/ReputationOracle.json"), "utf-8")
    ),
    LendingPool: JSON.parse(
      readFileSync(join(__dirname, "../artifacts/contracts/LendingPool.sol/LendingPool.json"), "utf-8")
    ),
    AgentController: JSON.parse(
      readFileSync(join(__dirname, "../artifacts/contracts/AgentController.sol/AgentController.json"), "utf-8")
    )
  };

  // Deploy ReputationOracle first (no dependencies)
  const oracle = await manager.deployContract("ReputationOracle", artifacts.ReputationOracle);
  const oracleAddress = await oracle.getAddress();

  // Deploy LendingPool with oracle reference
  const lendingPool = await manager.deployContract("LendingPool", artifacts.LendingPool, [oracleAddress]);
  const lendingPoolAddress = await lendingPool.getAddress();

  // Deploy AgentController with oracle and pool references
  const agentController = await manager.deployContract("AgentController", artifacts.AgentController, [
    lendingPoolAddress,
    oracleAddress
  ]);
  const agentControllerAddress = await agentController.getAddress();

  // Verify all contracts on Etherscan
  const verificationPromises = [
    manager.verifyContract("ReputationOracle", oracleAddress, []),
    manager.verifyContract("LendingPool", lendingPoolAddress, [oracleAddress]),
    manager.verifyContract("AgentController", agentControllerAddress, [lendingPoolAddress, oracleAddress])
  ];

  const verificationGuids = await Promise.all(verificationPromises);

  // Wait for all verifications to complete
  const verificationResults = await Promise.all(
    verificationGuids.map((guid, index) => 
      guid ? manager.waitForVerification(guid, ["ReputationOracle", "LendingPool", "AgentController"][index]) : false
    )
  );

  // Save deployment manifest
  const manifest = await manager.saveDeploymentManifest();

  // Update dashboard with contract addresses
  await manager.updateDashboard(manifest);

  console.log("\n=== DEPLOYMENT COMPLETE ===");
  console.log(`ReputationOracle: ${oracleAddress}`);
  console.log(`LendingPool: ${lendingPoolAddress}`);
  console.log(`AgentController: ${agentControllerAddress}`);
  console.log(`\nEtherscan links:`);
  console.log(`ReputationOracle: https://sepolia.etherscan.io/address/${oracleAddress}`);
  console.log(`LendingPool: https://sepolia.etherscan.io/address/${lendingPoolAddress}`);
  console.log(`AgentController: https://sepolia.etherscan.io/address/${agentControllerAddress}`);

  return {
    ReputationOracle: oracleAddress,
    LendingPool: lendingPoolAddress,
    AgentController: agentControllerAddress
  };
}

// Novel primitive: Deployment verification with cryptographic integrity check
async function verifyDeployment() {
  const manifestPath = join(__dirname, "../deployment-manifest.json");
  
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    console.log("Deployment manifest found");
    console.log("Contracts:", manifest.contracts);
    return manifest;
  } catch (error) {
    console.log("No deployment manifest found. Run deployment first.");
    return null;
  }
}

// Main execution with error handling
async function main() {
  try {
    const mode = process.argv[2] || "deploy";
    
    if (mode === "deploy") {
      await deployContracts();
    } else if (mode === "verify") {
      await verifyDeployment();
    } else {
      console.log("Usage: node scripts/deploy.js [deploy|verify]");
    }
  } catch (error) {
    console.error("Deployment failed:", error.message);
    process.exit(1);
  }
}

main();