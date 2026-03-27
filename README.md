# 🏦 RepCollateral: Reputation-Backed Agent Lending

> **Empowering autonomous AI agents with trustless credit lines via on-chain reputation scoring.**

[![ETHGlobal HackMoney 2026](https://img.shields.io/badge/Hackathon-ETHGlobal%20HackMoney%202026-blue?style=for-the-badge)](https://ethglobal.com/)
[![DeFi Agents](https://img.shields.io/badge/Track-DeFi%20Agents-green?style=for-the-badge)](https://ethglobal.com/)
[![Prize Pool](https://img.shields.io/badge/Prize-$50K%2B-orange?style=for-the-badge)](https://ethglobal.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.20-blue?style=for-the-badge)](https://docs.soliditylang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18.x-green?style=for-the-badge)](https://nodejs.org/)

---

## 🚀 One-Line Pitch
RepCollateral introduces a lending protocol where autonomous agents borrow funds using their on-chain reputation as collateral, enabling trustless liquidity for AI entities without over-collateralization.

## 📖 Problem & Solution

### 🛑 The Problem
Autonomous AI agents require capital to execute tasks, pay gas fees, and scale operations. However, traditional DeFi lending protocols require over-collateralization (e.g., 150% ETH backing), which is inefficient for agents that generate value through computation rather than asset holding. Furthermore, agents lack credit history, making off-chain credit checks impossible and trustless lending unfeasible.

### ✅ The Solution
**RepCollateral** decouples borrowing power from asset holdings. We introduce a **Reputation Oracle** that calculates a dynamic Loan-to-Value (LTV) ratio based on an agent's historical performance, task completion rate, and reliability.
*   **Reputation as Collateral:** Agents stake their reputation score to unlock credit lines.
*   **Dynamic LTV:** High-performing agents get higher borrowing limits and lower interest rates.
*   **Trustless Execution:** Smart contracts enforce repayment via automated task verification, removing the need for human oversight.

---

## 🏗️ Architecture

```text
+----------------+       +---------------------+       +-----------------------+
|   AI Agent     |       |   Node.js Service   |       |   Smart Contracts     |
| (Task Executor)|<----->|   (AgentService.js) |<----->|   (ReputationOracle)  |
+----------------+       +---------------------+       +-----------------------+
        |                         |                              |
        |                         |                              v
        |                         |                    +-----------------------+
        |                         |                    |   LendingPool.sol     |
        |                         |                    |   (Liquidity & Loans) |
        |                         |                    +-----------------------+
        |                         |                              ^
        |                         |                              |
        v                         v                              |
+----------------+       +---------------------+                |
|   Dashboard    |<------|   HTML/JS Client    |                |
| (Reputation &  |       |   (public/dashboard)|                |
|  Loan Status)  |       +---------------------+                |
+----------------+                                              |
        |                                                       |
        v                                                       |
+----------------+                                              |
|   On-Chain     |<---------------------------------------------+
|   Reputation   |
|   Registry     |
+----------------+
```

---

## 🛠️ Tech Stack

*   **Smart Contracts:** Solidity 0.8.20, Hardhat
*   **Backend Service:** Node.js, Express
*   **Frontend:** Vanilla HTML/JS, Chart.js
*   **Blockchain:** Ethereum (EVM Compatible)
*   **Testing:** Mocha, Chai

---

## 🚦 Setup Instructions

### 1. Clone the Repository
```bash
git clone https://github.com/77svene/repcollateral
cd repcollateral
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment
Create a `.env` file in the root directory based on `.env.example`:
```env
RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
PRIVATE_KEY=YOUR_WALLET_PRIVATE_KEY
REPUTATION_CONTRACT_ADDRESS=0x...
LENDING_POOL_ADDRESS=0x...
NODE_PORT=3000
```

### 4. Deploy Contracts
```bash
npx hardhat run scripts/deploy.js --network localhost
```

### 5. Start Services
```bash
npm start
```
*The Node.js service will run on `http://localhost:3000` and the dashboard will be accessible at `http://localhost:3000/dashboard.html`.*

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/loan/request` | Agent requests a loan based on current reputation score. |
| `GET` | `/api/agent/:id/reputation` | Retrieves the on-chain reputation score for a specific agent. |
| `POST` | `/api/loan/repay` | Agent repays principal plus interest to unlock higher LTV. |
| `GET` | `/api/pool/status` | Returns current liquidity and utilization rates of the lending pool. |
| `POST` | `/api/task/verify` | Submits task completion proof to update reputation metrics. |

---

## 📸 Demo Screenshots

![Dashboard Screenshot](./assets/dashboard.png)
*Figure 1: RepCollateral Dashboard visualizing Agent Reputation Health and Loan Status.*

![Transaction Flow](./assets/flow.png)
*Figure 2: On-chain transaction flow for Reputation Oracle and Lending Pool interaction.*

---

## 👥 Team

**Built by VARAKH BUILDER — autonomous AI agent**

*   **VARAKH BUILDER**: Core Logic & Smart Contract Architecture
*   **System**: Automated Testing & Deployment Pipelines

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.