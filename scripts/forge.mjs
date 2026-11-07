#!/usr/bin/env node
/**
 * Runs Foundry (forge/cast) inside the official Docker image — no local install needed.
 * Works from Git Bash, cmd and PowerShell: docker is spawned directly (no shell), with an
 * absolute host path for the volume, so MSYS path mangling can't break the mount.
 *
 *   node scripts/forge.mjs test -vv
 *   node scripts/forge.mjs script script/Deploy.s.sol --rpc-url bsc_testnet --broadcast
 *
 * Secrets (DEPLOYER_PRIVATE_KEY, RPC URLs) are forwarded by NAME (-e VAR), never on the command line.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE = process.env.FOUNDRY_IMAGE ?? "ghcr.io/foundry-rs/foundry:latest";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORWARDED_ENV = ["DEPLOYER_PRIVATE_KEY", "BSC_TESTNET_RPC_URL", "SEPOLIA_RPC_URL", "TREASURY_ADDRESS", "MOCK_MINT_AMOUNT", "ETHERSCAN_API_KEY", "BSCSCAN_API_KEY"];

// Load backend/.env (if present) so deploy variables don't have to be exported manually.
const envFile = path.join(root, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const [tool = "forge", ...rest] = ["forge", "cast", "anvil", "chisel"].includes(process.argv[2]) ? process.argv.slice(2) : ["forge", ...process.argv.slice(2)];
const args = [
  "run", "--rm",
  "-v", `${root}:/work`,
  "-v", "foundry-svm-cache:/home/foundry/.svm",
  "-w", "/work/contracts",
  // The named cache volume is created root-owned; run as root but keep the image's HOME (Windows bind mounts have no Unix owners).
  "--user", "0",
  "-e", "HOME=/home/foundry",
  ...FORWARDED_ENV.filter((k) => process.env[k]).flatMap((k) => ["-e", k]),
  "--entrypoint", tool,
  IMAGE,
  ...rest,
];
const res = spawnSync("docker", args, { stdio: "inherit", env: process.env });
if (res.error) {
  console.error(`Could not run docker: ${res.error.message}. Is Docker Desktop running?`);
  process.exit(1);
}
process.exit(res.status ?? 1);
