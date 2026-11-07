# Batch Payout API (backend)

One-click batch crypto payouts. **Accounts** export an Excel withdrawal list, a **maker** uploads it, a **checker** approves it, and an **executor** pays the whole list with one click, through either:

1. **MEXC** (custodial, Spot v3 API, server-side): TRC20 · BEP20 · ERC20.
2. **Trust Wallet** (non-custodial, EVM only: BEP20 · ERC20): the browser signs **one** transaction to the `BatchPayout` contract. The private key never reaches the server.

Everything runs on **TESTNET / DRY-RUN** by default. No real funds move.

NestJS 12 · TypeScript 6 (strict) · PostgreSQL 17 + Drizzle · BullMQ + Redis · exceljs · zod · viem · Foundry (in Docker) · vitest · Swagger at `/docs`.

---

## Quick start

### A. Zero dependencies (embedded DB, in-process queue)

```bash
npm install
npm run build
DATABASE_DRIVER=pglite QUEUE_DRIVER=memory npm start     # http://localhost:4000/api · /docs
```

PGlite migrates and seeds itself on boot, and jobs run inside the API process. This mode is for demos; data is lost on restart unless `PGLITE_DIR` is a folder.

### B. Production-like (Postgres + Redis, separate worker)

```bash
npm install
cp .env.example .env            # DRY_RUN=true, DEMO_AUTH=true, PORT=4000, testnet defaults
docker compose up -d            # postgres:17 + redis:7 (healthchecked, memory-capped)
npm run db:migrate
npm run db:seed                 # 4 demo users + batches in every status (idempotent)
npm run build
npm start                       # terminal 1: API on :4000
npm run start:worker            # terminal 2: BullMQ worker (payouts + tx verification)
```

Stop with `docker compose stop`, or `docker compose down -v` to wipe the data.

### Connect the frontend

In `frontend/.env.local`:

```
NEXT_PUBLIC_API_MODE=live
NEXT_PUBLIC_API_URL=http://localhost:4000/api
```

CORS allows `http://localhost:3000` (`CORS_ORIGIN`). The frontend's role switcher reads `GET /demo/users`, which is only available with `DEMO_AUTH=true`.

| Demo user | Role | Token |
|---|---|---|
| Sara Haddad | maker | `demo-maker-sara-7f3c9a2b41d6e8f05a1c` |
| Youssef Amin | maker | `demo-maker-youssef-4d6f8a0c2e1b3d5f7a9c` |
| Omar Khalil | checker | `demo-checker-omar-2b8e4d6f0a1c3e5b7d9f` |
| Lina Mansour | executor | `demo-executor-lina-9c1e3a5b7d0f2e4a6c8b` |

The database stores only `sha256(token)`.

---

## Architecture

```
src/
  domain/            pure TypeScript, no framework imports
    amount.ts          exact decimal (bigint × 10^18); toBaseUnits() THROWS on extra precision
    address.ts         EVM (EIP-55 only when mixed-case, like viem) · TRON base58check
    batch-status.ts    draft → approved|rejected → processing → completed|completed_with_issues|failed (illegal → 409)
    item-status.ts     pending → processing → succeeded|failed|requires_reconciliation
    withdrawal-rules.ts  all-or-nothing sheet validation with stable issue codes
    batch-ref.ts       batch UUID → bytes32 (right-padded)
    errors.ts · ports/ (PayoutGateway, TransactionVerifier, PayoutQueue, PayoutRepository, Clock, IdGenerator, SheetReader)
  application/       use cases: ValidateWithdrawalSheet, ImportWithdrawalSheet, ReviewBatch, ExecuteBatch,
                     PayoutItemProcessor, SettleBatch, PrepareOnchainBatch, ConfirmOnchainBatch, PayoutQueries
  infrastructure/    db/ (Drizzle schema, repository, seed, CLI) · mexc/ (signed client + gateway)
                     dry-run-payout.gateway · chain/ (viem verifier, simulator, router) · queue/ (BullMQ, in-memory)
                     xlsx/ (exceljs reader + template) · config/env.ts (zod)
  interface/http/    thin controllers · AuthGuard (hashed bearer) · RolesGuard · exception filter · presenters
  core.module.ts     composition root: every port bound to an explicit DI token by a factory
  main.ts            API          worker.ts   queue worker
contracts/           BatchPayout.sol · MockUSDT.sol · Foundry tests · Deploy.s.sol
drizzle/             SQL migrations (incl. append-only audit trigger)
test/unit, test/integration
```

- **The gateway strategy is chosen in one place:** `createPayoutGateway()` in `core.module.ts`. `PAYOUTS_DRY_RUN=true` selects `DryRunPayoutGateway`; otherwise it's `MexcPayoutGateway`.
- **The verifier is chosen per chain** in `createVerifier()`. A chain gets the real `ViemTransactionVerifier` when RPC, contract and token are configured. It gets the simulator **only** when `PAYOUTS_DRY_RUN=true` *and* that chain has no contract.

---

## Flow 1: MEXC (custodial)

1. **`POST /batches`** (maker) parses the sheet and validates every row, reporting all errors at once. It then inserts the batch and all its items in one DB transaction (`draft`), so the import is all-or-nothing.
2. **`POST /batches/:id/approve`** (checker) runs under `SELECT … FOR NO KEY UPDATE`. Four-eyes applies: the uploader can never approve their own batch (422 `FOUR_EYES`).
3. **`POST /batches/:id/execute`** (executor) runs in a DB transaction with a row lock and moves the batch approved → processing **exactly once**. A double click gets 409. It then enqueues **one BullMQ job per item, with `jobId = itemId`**, so enqueueing twice does nothing.
4. **The worker** handles each item:
   - It claims the item under row locks and commits `sending = true` *before* calling MEXC.
   - It calls `POST /api/v3/capital/withdraw` with `coin, withdrawOrderId (= item ULID), netWork, address, amount, memo?, remark, recvWindow, timestamp, signature`. The signature is HMAC-SHA256 of the exact query string, sent with the `X-MEXC-APIKEY` header.
   - It is rate-limited (`PAYOUT_RATE_LIMIT_PER_SEC`) and backs off exponentially.
5. **Outcome classification:**

   | What happened | Item becomes | Retried? |
   |---|---|---|
   | DNS failure / connection refused (never delivered), or **429** | (back to queue) | ✅ exponential backoff; after `PAYOUT_MAX_ATTEMPTS`, `failed` |
   | other **4xx** | `failed` | ❌ |
   | timeout after send, connection reset, **5xx**, 2xx **without an id** | `requires_reconciliation` | ❌ **never** |
   | a worker crash between claim and record (`sending` still true) | `requires_reconciliation` | ❌ |
   | 2xx with an id | `succeeded` (`providerReference` = MEXC id) | |

6. **Settlement:** after each result, the batch is settled **under its row lock**, and only once no item is pending or processing. The result is `completed` when all items succeeded, `failed` when all failed, and `completed_with_issues` otherwise.

**Dry-run** (`PAYOUTS_DRY_RUN=true`, the default): nothing leaves the server. A reference ending in `-FAIL` fails and `-RECON` becomes `requires_reconciliation`, the same convention as the frontend mock. Each item gets a small random delay so the UI can show progress.

> **MEXC network codes** (`MEXC_NETWORK_TRC20/BEP20/ERC20`, defaults `TRX`/`BSC`/`ETH`) must be confirmed with `GET /api/v3/capital/config/getall` (field `netWork` for coin USDT) before going live. MEXC has **no withdrawal testnet**, so live mode requires both `PAYOUTS_DRY_RUN=false` and `ALLOW_LIVE_MEXC=true`.

## Flow 2: Trust Wallet (non-custodial)

1. **`GET /batches/:id/onchain-payload`** (executor, approved batch) returns `{ chainId, contract, token, tokenDecimals, treasury, batchRef, recipients, amounts, total }`:
   - **`amounts[]` and `total` are raw token base units** (integer strings).
   - **`batchRef`** is the batch UUID as bytes32, right-padded: `0x<32 hex of the uuid><32 zeros>`.
2. **The browser** has the treasury approve exactly `total`, then calls `payout(batchRef, token, recipients, amounts)`.
3. **`POST /batches/:id/transaction { txHash }`** moves approved → processing exactly once (409 on repeat) and queues verification.
4. **The verification job** polls with viem until `N` confirmations (`*_CONFIRMATIONS`), then requires all of the following:
   - `status == success`, `from == treasury` and `to == contract`;
   - a `BatchPaid` log from that contract with `topics[1] ==` the **exact** batchRef that was issued;
   - `payer == treasury`, `token ==` the configured token, and `total` and `count` equal to the batch.

   | Result | Items |
   |---|---|
   | confirmed | `succeeded` |
   | reverted | `failed` (no funds moved) |
   | mismatch, or not confirmed within `VERIFY_TIMEOUT_MS` | `requires_reconciliation` |

**Simulator:** this applies only when `PAYOUTS_DRY_RUN=true` and a network has no RPC or contract configured. Any well-formed hash is "confirmed" after `DRY_RUN_CHAIN_CONFIRM_MS`. A warning is logged at startup, and the batch (`simulated: true`) and audit context (`"simulated": true`) both show it.

---

## Design decisions

- **Idempotency at every layer.**
  - `execute` and `transaction` flip the status under a row lock, so they happen exactly once.
  - The `jobId = itemId` dedupe means a job can't be enqueued twice.
  - `withdrawOrderId = itemId` lets MEXC dedupe on its side.
  - A unique index on `tx_hash` means one transaction can settle only one batch.
  - The contract keeps `paid[payer][batchRef]`.
- **No retry on an unknown outcome.** A request that *may* have executed is never re-sent; it goes to `requires_reconciliation` for a human. The `sending` flag is committed before the provider call, so a crash mid-send can't cause a double payment either.
- **Four-eyes.** Roles are separate (maker / checker / executor), and the uploader can never approve their own batch, even after a role change (422 `FOUR_EYES`). The use cases re-check roles behind the `RolesGuard`.
- **Non-custodial on-chain path.** The server never holds or asks for a private key. It only builds the payload and verifies the result. The contract has no owner, holds no funds, and pays from the caller via `safeTransferFrom`.
- **Exact money.** `Amount` is a bigint scaled by 10^18, stored in `numeric(36,18)`, and every API amount is a string. `toBaseUnits()` throws instead of rounding.
- **Append-only audit.** Every action and item result is logged (actor, action, context JSON, time). A Postgres trigger rejects `UPDATE`, `DELETE` and `TRUNCATE` on `audit_log`.
- **Duplicate files.** The sha256 of the file is checked against live batches. A partial unique index (`WHERE status <> 'rejected'`) enforces it, so a corrected file can be re-uploaded after a rejection.
- **Locking (found by running on real Postgres).** Batch and item locks use `FOR NO KEY UPDATE`, and every writer locks the batch before items. Audit and item inserts take `FOR KEY SHARE` on the batch through their foreign key, and plain `FOR UPDATE` deadlocked two workers settling the same batch. `test/integration/postgres-concurrency.test.ts` reproduces that deadlock against the original code.
- **Limits.** MEXC: max 1000 rows and min 1 USDT per row. Trust Wallet: max 200 rows (the contract's cap). Max 2 MB per file, max 6 decimals, and a max batch total, checked both at import and at approval. `GET /config` exposes `maxRowsByChannel` and keeps `maxRows = 1000` for compatibility.

## Excel validation

The columns are `reference, address, amount, asset, network, memo?`. Headers are case-insensitive and BOM-safe. Cells are read as text: amounts or addresses stored as Excel numbers, formulas or scientific notation are rejected. All errors are reported, one entry per Excel row, with `row: 0` for whole-file problems. Each error carries English `messages` plus stable `issues` codes for i18n:

```json
{ "row": 5, "messages": ["Duplicate reference \"WD-1\" (first used on row 2)."],
  "issues": [{ "code": "reference.duplicate", "params": { "reference": "WD-1", "firstRow": 2 } }] }
```

**Issue codes:**
- **Row-level:** `address.invalid`, `amount.not_positive`, `amount.zero`, `amount.too_precise`, `amount.not_number`, `amount.below_minimum`, `reference.duplicate`, `reference.required`, `asset.unsupported`, `network.unsupported`, `network.unsupported_for_channel`.
- **Whole-file (row 0):** `file.missing_columns`, `file.empty`, `file.duplicate`, `file.mixed_network`, `file.too_many_rows`, `batch.total_exceeds_limit`.
- **Added to the list you gave me:** `file.too_large` (over 2 MB) and `file.unreadable` (not a readable .xlsx). Both are also row 0.

---

## API

Base `http://localhost:4000/api` · `GET /health` (public, checks the DB) · JSON · camelCase · `Authorization: Bearer <token>`. Errors use `{ message, code, errors? }`:

| Status | Meaning |
|---|---|
| 401 | unauthenticated |
| 403 | wrong role |
| 404 | not found |
| 409 | illegal state |
| 422 | validation or policy |

The full, interactive spec is at **`/docs`**. Batches include an extra `simulated: true` field when a simulated verification settled them.

### curl examples

```bash
B=http://localhost:4000/api
M=demo-maker-sara-7f3c9a2b41d6e8f05a1c; C=demo-checker-omar-2b8e4d6f0a1c3e5b7d9f; X=demo-executor-lina-9c1e3a5b7d0f2e4a6c8b

curl -s $B/config
curl -s -H "Authorization: Bearer $M" $B/dashboard/stats
curl -s -H "Authorization: Bearer $M" -o template.xlsx $B/templates/withdrawals.xlsx

curl -s -H "Authorization: Bearer $M" -F channel=mexc -F file=@withdrawals.xlsx $B/batches/validate
ID=$(curl -s -H "Authorization: Bearer $M" -F channel=mexc -F file=@withdrawals.xlsx $B/batches | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

curl -s -X POST -H "Authorization: Bearer $C" $B/batches/$ID/approve
curl -s -X POST -H "Authorization: Bearer $X" $B/batches/$ID/execute          # 202
curl -s -X POST -H "Authorization: Bearer $X" $B/batches/$ID/execute          # 409
curl -s -H "Authorization: Bearer $X" "$B/batches/$ID/items?status=failed"
curl -s -H "Authorization: Bearer $X" "$B/audit?batchId=$ID"

# Trust Wallet batch:
curl -s -H "Authorization: Bearer $X" $B/batches/$TW/onchain-payload
curl -s -X POST -H "Authorization: Bearer $X" -H 'Content-Type: application/json' \
  -d '{"txHash":"0x…64 hex…"}' $B/batches/$TW/transaction                    # 202
```

---

## Contracts (Foundry in Docker)

Foundry runs from `ghcr.io/foundry-rs/foundry` through `scripts/forge.mjs`, so nothing is installed locally. The script spawns `docker` directly with an absolute host path, so the volume mount works from Git Bash, cmd and PowerShell. Secrets are passed to the container by name only.

```bash
npm run contracts:setup         # one-time: forge-std → contracts/lib (OpenZeppelin comes from npm)
npm run contracts:test          # 14 tests: happy path, replay, griefing, mismatch, allowance/balance, fuzz
npm run contracts:deploy -- local        # smoke test against anvil inside the container
```

`BatchPayout.payout(bytes32 batchRef, IERC20 token, address[] recipients, uint256[] amounts)` emits `BatchPaid(bytes32 indexed batchRef, address indexed token, address indexed payer, uint256 total, uint256 count)`. It has no owner and holds no funds. It reverts on an empty batch, more than 200 recipients, a length mismatch, a zero address, or a replay. `paid[payer][batchRef]` is set before any transfer, and because it's keyed by payer, nobody can burn the treasury's batchRef by front-running it.

### Deploy to a testnet

1. Create a **throwaway testnet** key. Never use a real wallet's key. Fund it from a faucet: BSC Testnet (chain 97) or Sepolia (chain 11155111).
2. In `backend/.env`, set `DEPLOYER_PRIVATE_KEY`, `TREASURY_ADDRESS`, and `BSC_TESTNET_RPC_URL` and/or `SEPOLIA_RPC_URL`.
3. Run `npm run contracts:deploy -- bsc_testnet` (or `-- sepolia`). This deploys `MockUSDT` (6 decimals, open faucet `mint`) and `BatchPayout`, and mints test USDT to the treasury.
4. Copy the logged addresses into `.env`:

   ```
   BEP20_RPC_URL=…
   BEP20_PAYOUT_CONTRACT=0x…
   BEP20_TOKEN_ADDRESS=0x…
   BEP20_TOKEN_DECIMALS=6
   ```

   Use the `ERC20_*` variables for Sepolia. Restart the API and worker. That network is then verified for real, and its startup simulation warning disappears.

---

## Tests

| Command | What it covers |
|---|---|
| `npm test` | Everything below except the Postgres suite (vitest, `maxWorkers: 2`) |
| `npm run test:unit` | Amount, addresses, state machines, Excel parser and rules, MEXC gateway with mocked `fetch` (exact signed request, error classification), viem verifier |
| `npm run test:integration` | PGlite + in-memory queue, no Docker. Covers the full HTTP contract: import → validation errors → four-eyes 422 → approve → parallel execute 202/409 → completed. Also: unknown outcome → completed_with_issues, role checks (403), duplicate and re-upload rules, Trust Wallet payload in base units plus simulated verification, and the processor's exactly-once rules |
| `TEST_DATABASE_URL=postgres://payout:payout@localhost:5432/payout npm run test:integration` | Also runs the real-Postgres concurrency suite: 40 items on 10 workers with duplicate deliveries, and 20 parallel executes |
| `npm run contracts:test` | Foundry |

Vitest 5 replaced `poolOptions.maxThreads/maxForks` with `maxWorkers`. It is set to 2 for this low-RAM machine.
