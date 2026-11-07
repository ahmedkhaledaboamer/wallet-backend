#!/usr/bin/env node
/**
 * Deploys MockUSDT + BatchPayout via the dockerized Foundry.
 *
 *   npm run contracts:deploy -- bsc_testnet   # chain 97,       needs BSC_TESTNET_RPC_URL + DEPLOYER_PRIVATE_KEY
 *   npm run contracts:deploy -- sepolia       # chain 11155111, needs SEPOLIA_RPC_URL + DEPLOYER_PRIVATE_KEY
 *   npm run contracts:deploy -- local         # smoke test against a throwaway anvil chain inside the container
 *
 * DEPLOYER_PRIVATE_KEY must be a throwaway TESTNET key, read from the environment or backend/.env.
 * It is passed to Docker by name only, never printed or put on a command line.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forge = path.join(root, "scripts", "forge.mjs");

if (target === "local") {
  // anvil's well-known dev account #0 — public test key, holds nothing of value.
  const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const res = spawnSync(
    "docker",
    [
      "run", "--rm", "--user", "0", "-e", "HOME=/home/foundry",
      "-v", `${root}:/work`, "-v", "foundry-svm-cache:/home/foundry/.svm", "-w", "/work/contracts",
      "-e", `DEPLOYER_PRIVATE_KEY=${ANVIL_KEY}`,
      "--entrypoint", "sh", process.env.FOUNDRY_IMAGE ?? "ghcr.io/foundry-rs/foundry:latest",
      "-c", "anvil --silent & sleep 2 && forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast",
    ],
    { stdio: "inherit" },
  );
  process.exit(res.status ?? 1);
}

if (target !== "bsc_testnet" && target !== "sepolia") {
  console.error("Usage: npm run contracts:deploy -- <bsc_testnet|sepolia|local>");
  process.exit(2);
}

const res = spawnSync(process.execPath, [forge, "script", "script/Deploy.s.sol", "--rpc-url", target, "--broadcast", "-vv"], {
  stdio: "inherit",
});
if (res.status === 0) {
  console.log(
    `\nNext: copy the logged addresses into backend/.env as ${target === "bsc_testnet" ? "BEP20" : "ERC20"}_PAYOUT_CONTRACT and ${
      target === "bsc_testnet" ? "BEP20" : "ERC20"
    }_TOKEN_ADDRESS, and set TREASURY_ADDRESS.`,
  );
}
process.exit(res.status ?? 1);
