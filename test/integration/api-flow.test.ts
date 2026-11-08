import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users } from "../../src/infrastructure/db/schema";
import { buildWithdrawalWorkbook, type SheetRowInput } from "../../src/infrastructure/xlsx/template";
import { evmAddress, tronAddress } from "../helpers/addresses";
import { CHECKER, EXECUTOR, MAKER, MAKER2, startTestApp, type TestApp } from "../helpers/app";

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp();
}, 60_000);
afterAll(() => t?.close());

let seq = 0;
const tronRows = (refs: string[], amount = "12.5"): SheetRowInput[] =>
  refs.map((reference) => ({ reference, address: tronAddress(1000 + ++seq), amount, asset: "USDT", network: "TRC20" }));

/** Builds the workbook, then posts it. Returns a thenable with supertest-style .expect(status). */
function upload(token: string, rows: SheetRowInput[], channel: "mexc" | "trust_wallet" = "mexc", path = "/batches") {
  const file = () => buildWithdrawalWorkbook(rows).then((b) => Buffer.from(b));
  // Don't await the supertest request inside here: awaiting it resolves to a plain Response.
  const request = (f: Buffer) => t.as(token).post(path).field("channel", channel).attach("file", f, "withdrawals.xlsx");
  return {
    expect: async (status: number) => request(await file()).expect(status),
    then: <A, B>(ok: (r: Awaited<ReturnType<typeof request>>) => A, fail?: (e: unknown) => B) => file().then(request).then(ok, fail),
  };
}

describe("contract basics", () => {
  it("GET /config is public and exposes per-channel limits", async () => {
    const r = await t.http().get("/api/config").expect(200);
    expect(r.body).toMatchObject({ environment: "testnet", dryRun: true, maxRows: 1000, maxRowsByChannel: { mexc: 1000, trust_wallet: 200 }, maxBatchTotal: "250000" });
    expect(r.body.networks.map((n: { network: string }) => n.network)).toEqual(["TRC20", "BEP20", "ERC20"]);
  });

  it("GET /demo/users lists 4 users with tokens (DEMO_AUTH=true)", async () => {
    const r = await t.http().get("/api/demo/users").expect(200);
    expect(r.body).toHaveLength(4);
    expect(r.body[0]).toEqual({ id: "usr_sara_haddad", name: "Sara Haddad", role: "maker", token: MAKER });
  });

  it("401 without / with an unknown token, in the contract error shape", async () => {
    const r = await t.http().get("/api/me").expect(401);
    expect(r.body).toEqual({ message: expect.any(String), code: "UNAUTHENTICATED" });
    await t.as("not-a-real-token-1234567890").get("/me").expect(401);
  });

  it("GET /me", async () => {
    expect((await t.as(CHECKER).get("/me").expect(200)).body).toEqual({ id: "usr_omar_khalil", name: "Omar Khalil", role: "checker" });
  });

  it("404 for unknown / malformed batch ids", async () => {
    expect((await t.as(MAKER).get("/batches/00000000-0000-4000-8000-000000000000").expect(404)).body.code).toBe("NOT_FOUND");
    await t.as(MAKER).get("/batches/not-a-uuid").expect(404);
  });

  it("422 for invalid query params", async () => {
    expect((await t.as(MAKER).get("/batches?status=paid").expect(422)).body.code).toBe("VALIDATION_FAILED");
    await t.as(MAKER).get("/batches?pageSize=0").expect(422);
  });

  it("serves the Excel template", async () => {
    const r = await t.as(MAKER).get("/templates/withdrawals.xlsx").expect(200);
    expect(r.headers["content-type"]).toContain("spreadsheetml");
    expect(r.headers["content-disposition"]).toContain("withdrawals-template.xlsx");
  });

  it("seeded demo data: batches in every status, dashboard numbers as strings", async () => {
    const statuses = new Set<string>();
    const r = await t.as(MAKER).get("/batches?pageSize=100").expect(200);
    for (const b of r.body.data) statuses.add(b.status);
    expect([...statuses].sort()).toEqual(["approved", "completed", "completed_with_issues", "draft", "failed", "processing", "rejected"].filter((s) => s !== "processing" || statuses.has("processing")).sort());
    const s = (await t.as(MAKER).get("/dashboard/stats").expect(200)).body;
    expect(typeof s.totalPaid).toBe("string");
    expect(s.byChannel.map((c: { channel: string }) => c.channel)).toEqual(["mexc", "trust_wallet"]);
  });
});

describe("MEXC flow: import → four-eyes → approve → execute once → completed", () => {
  let id: string;

  it("validate reports all errors with row numbers and issue codes", async () => {
    const rows = [...tronRows(["V-1", "V-2"]), { reference: "V-1", address: "bad", amount: "0.5", asset: "USDT", network: "TRC20" }];
    const r = await upload(MAKER, rows, "mexc", "/batches/validate").expect(200);
    expect(r.body.valid).toBe(false);
    expect(r.body.errors).toEqual([
      {
        row: 4,
        issues: [
          { code: "reference.duplicate", params: { reference: "V-1", firstRow: 2 } },
          { code: "address.invalid", params: { address: "bad", network: "TRC20" } },
          { code: "amount.below_minimum", params: { value: "0.5", minimum: "1", channel: "mexc" } },
        ],
        messages: expect.any(Array),
      },
    ]);
  });

  it("POST /batches with errors → 422 with errors[] and nothing stored", async () => {
    const before = (await t.as(MAKER).get("/batches").expect(200)).body.meta.total;
    const r = await upload(MAKER, [{ reference: "X", address: "nope", amount: "1", asset: "USDT", network: "TRC20" }]).expect(422);
    expect(r.body.code).toBe("VALIDATION_FAILED");
    expect(r.body.errors[0].row).toBe(2);
    expect((await t.as(MAKER).get("/batches").expect(200)).body.meta.total).toBe(before);
  });

  it("imports a valid file as a draft (201)", async () => {
    const r = await upload(MAKER, tronRows(["M-1", "M-2", "M-3"], "100.10")).expect(201);
    id = r.body.id;
    expect(r.body).toMatchObject({ status: "draft", channel: "mexc", network: "TRC20", asset: "USDT", totalAmount: "300.3", itemCount: 3, createdBy: { name: "Sara Haddad" } });
  });

  it("four-eyes: the uploader can never approve their own batch (422)", async () => {
    // Simulate the uploader later being granted the checker role.
    await t.db.db.update(users).set({ role: "checker" }).where(eq(users.id, "usr_sara_haddad"));
    try {
      const r = await t.as(MAKER).post(`/batches/${id}/approve`).expect(422);
      expect(r.body.code).toBe("FOUR_EYES");
    } finally {
      await t.db.db.update(users).set({ role: "maker" }).where(eq(users.id, "usr_sara_haddad"));
    }
  });

  it("execute before approval → 409", async () => {
    expect((await t.as(EXECUTOR).post(`/batches/${id}/execute`).expect(409)).body.code).toBe("ILLEGAL_STATE");
  });

  it("checker approves", async () => {
    const r = await t.as(CHECKER).post(`/batches/${id}/approve`).expect(200);
    expect(r.body).toMatchObject({ status: "approved", approvedBy: { name: "Omar Khalil" } });
    expect(r.body.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await t.as(CHECKER).post(`/batches/${id}/approve`).expect(409);
  });

  it("execute → 202 processing; a second execute → 409 (exactly once)", async () => {
    const [a, b] = await Promise.all([t.as(EXECUTOR).post(`/batches/${id}/execute`), t.as(EXECUTOR).post(`/batches/${id}/execute`)]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const ok = a.status === 202 ? a : b;
    expect(ok.body).toMatchObject({ status: "processing", executedBy: { name: "Lina Mansour" } });
    await t.as(EXECUTOR).post(`/batches/${id}/execute`).expect(409);
  });

  it("worker pays every item and settles the batch as completed", async () => {
    await t.queue.drain();
    const b = (await t.as(MAKER).get(`/batches/${id}`).expect(200)).body;
    expect(b).toMatchObject({ status: "completed", paidCount: 3, failedCount: 0, reconciliationCount: 0 });
    expect(b.completedAt).toBeTruthy();
    const items = (await t.as(MAKER).get(`/batches/${id}/items`).expect(200)).body;
    expect(items.meta).toEqual({ page: 1, pageSize: 50, total: 3 });
    expect(items.data.every((i: { status: string; providerReference: string }) => i.status === "succeeded" && i.providerReference.startsWith("DRYRUN-"))).toBe(true);
    const actions = (await t.as(MAKER).get(`/batches/${id}/audit`).expect(200)).body.map((a: { action: string }) => a.action);
    expect(actions).toEqual(["batch.created", "batch.approved", "batch.execution_started", "item.succeeded", "item.succeeded", "item.succeeded", "batch.completed"]);
  });

  it("items support search, status filter and pagination", async () => {
    const r = await t.as(MAKER).get(`/batches/${id}/items?search=m-2&pageSize=1`).expect(200);
    expect(r.body.data.map((i: { reference: string }) => i.reference)).toEqual(["M-2"]);
    expect((await t.as(MAKER).get(`/batches/${id}/items?status=failed`).expect(200)).body.meta.total).toBe(0);
  });

  it("re-uploading the same file is rejected (file.duplicate, row 0)", async () => {
    const rows = tronRows(["D-1"]);
    const file = Buffer.from(await buildWithdrawalWorkbook(rows));
    await t.as(MAKER).post("/batches").field("channel", "mexc").attach("file", file, "a.xlsx").expect(201);
    const r = await t.as(MAKER).post("/batches").field("channel", "mexc").attach("file", file, "a.xlsx").expect(422);
    expect(r.body.errors).toEqual([expect.objectContaining({ row: 0, issues: [expect.objectContaining({ code: "file.duplicate" })] })]);
  });

  it("a rejected batch frees its file for a corrected re-upload", async () => {
    const file = Buffer.from(await buildWithdrawalWorkbook(tronRows(["R-1"])));
    const first = await t.as(MAKER2).post("/batches").field("channel", "mexc").attach("file", file, "r.xlsx").expect(201);
    await t.as(CHECKER).post(`/batches/${first.body.id}/reject`).send({ reason: "no" }).expect(422);
    const rej = await t.as(CHECKER).post(`/batches/${first.body.id}/reject`).send({ reason: "Wrong payroll month" }).expect(200);
    expect(rej.body).toMatchObject({ status: "rejected", rejectionReason: "Wrong payroll month" });
    expect(rej.body.approvedBy).toBeUndefined();
    await t.as(MAKER2).post("/batches").field("channel", "mexc").attach("file", file, "r.xlsx").expect(201);
  });
});

describe("unknown outcomes are never retried", () => {
  it("a -RECON item → requires_reconciliation; -FAIL → failed; batch completed_with_issues", async () => {
    const r = await upload(MAKER, tronRows(["U-1", "U-2-RECON", "U-3-FAIL"])).expect(201);
    const id = r.body.id;
    await t.as(CHECKER).post(`/batches/${id}/approve`).expect(200);
    await t.as(EXECUTOR).post(`/batches/${id}/execute`).expect(202);
    await t.queue.drain();
    const b = (await t.as(MAKER).get(`/batches/${id}`).expect(200)).body;
    expect(b).toMatchObject({ status: "completed_with_issues", paidCount: 1, failedCount: 1, reconciliationCount: 1 });
    const recon = (await t.as(MAKER).get(`/batches/${id}/items?status=requires_reconciliation`).expect(200)).body.data[0];
    expect(recon.failureReason).toMatch(/outcome unknown/);
    const audit = (await t.as(MAKER).get(`/audit?batchId=${id}&action=item.requires_reconciliation`).expect(200)).body;
    expect(audit.meta.total).toBe(1);
    expect(audit.data[0].context.reference).toBe("U-2-RECON");
  });
});

describe("roles (403)", () => {
  it.each([
    ["checker uploads", () => upload(CHECKER, tronRows(["Z-1"]))],
    ["executor validates", () => upload(EXECUTOR, tronRows(["Z-2"]), "mexc", "/batches/validate")],
    ["maker approves", () => t.as(MAKER).post("/batches/00000000-0000-4000-8000-000000000000/approve")],
    ["executor rejects", () => t.as(EXECUTOR).post("/batches/00000000-0000-4000-8000-000000000000/reject").send({ reason: "nope nope" })],
    ["checker executes", () => t.as(CHECKER).post("/batches/00000000-0000-4000-8000-000000000000/execute")],
    ["maker reads the on-chain payload", () => t.as(MAKER).get("/batches/00000000-0000-4000-8000-000000000000/onchain-payload")],
    ["checker submits a tx", () => t.as(CHECKER).post("/batches/00000000-0000-4000-8000-000000000000/transaction").send({ txHash: "0x" + "1".repeat(64) })],
  ])("%s → 403 FORBIDDEN_ROLE", async (_, call) => {
    const r = await call();
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("FORBIDDEN_ROLE");
  });
});

describe("Trust Wallet flow", () => {
  let id: string;
  const evmRows = (n: number): SheetRowInput[] =>
    Array.from({ length: n }, (_, i) => ({ reference: `TW-${i + 1}`, address: evmAddress(500 + i).toLowerCase(), amount: ["250.00", "0.5", "1200.123456"][i % 3]!, asset: "USDT", network: "BEP20" }));

  it("rejects TRC20 and >200 rows for trust_wallet", async () => {
    const trc = await upload(MAKER, tronRows(["T-1"]), "trust_wallet", "/batches/validate").expect(200);
    expect(trc.body.errors[0].issues[0].code).toBe("network.unsupported_for_channel");
    const big = await upload(MAKER, evmRows(201), "trust_wallet", "/batches/validate").expect(200);
    expect(big.body.errors[0]).toMatchObject({ row: 0, issues: [{ code: "file.too_many_rows", params: { count: 201, max: 200, channel: "trust_wallet" } }] });
  });

  it("/execute is not allowed for trust_wallet batches (422)", async () => {
    id = (await upload(MAKER, evmRows(3), "trust_wallet").expect(201)).body.id;
    await t.as(CHECKER).post(`/batches/${id}/approve`).expect(200);
    expect((await t.as(EXECUTOR).post(`/batches/${id}/execute`).expect(422)).body.code).toBe("CHANNEL_MISMATCH");
  });

  it("onchain-payload returns RAW base units, checksummed recipients and the right-padded batchRef", async () => {
    const p = (await t.as(EXECUTOR).get(`/batches/${id}/onchain-payload`).expect(200)).body;
    expect(p).toMatchObject({ chainId: 97, tokenDecimals: 6, treasury: "0x8ba1f109551bD432803012645Ac136ddd64DBA72" });
    expect(p.amounts).toEqual(["250000000", "500000", "1200123456"]);
    expect(p.total).toBe("1450623456");
    expect(p.batchRef).toBe(`0x${id.replace(/-/g, "")}${"0".repeat(32)}`);
    expect(p.recipients[0]).toBe(evmAddress(500)); // stored checksummed
  });

  it("onchain-payload for a MEXC batch → 422", async () => {
    const mexc = (await t.as(MAKER).get("/batches?channel=mexc&status=approved").expect(200)).body.data[0];
    await t.as(EXECUTOR).get(`/batches/${mexc.id}/onchain-payload`).expect(422);
  });

  it("txHash is validated (422), then accepted once (202) and verified (simulated)", async () => {
    await t.as(EXECUTOR).post(`/batches/${id}/transaction`).send({ txHash: "0x123" }).expect(422);
    const hash = "0x" + "ab".repeat(32);
    const r = await t.as(EXECUTOR).post(`/batches/${id}/transaction`).send({ txHash: hash }).expect(202);
    expect(r.body).toMatchObject({ status: "processing", txHash: hash, simulated: true });
    await t.as(EXECUTOR).post(`/batches/${id}/transaction`).send({ txHash: hash }).expect(409);
    await t.as(EXECUTOR).get(`/batches/${id}/onchain-payload`).expect(409);

    await t.queue.drain();
    const b = (await t.as(MAKER).get(`/batches/${id}`).expect(200)).body;
    expect(b).toMatchObject({ status: "completed", paidCount: 3, simulated: true });
    const audit = (await t.as(MAKER).get(`/batches/${id}/audit`).expect(200)).body;
    const submitted = audit.find((a: { action: string }) => a.action === "batch.transaction_submitted");
    expect(submitted.context).toMatchObject({ txHash: hash, simulated: true });
    expect(audit.find((a: { action: string }) => a.action === "batch.transaction_verified").context).toMatchObject({ result: "confirmed", simulated: true });
  });
});

describe("Excel export of a batch's withdrawals", () => {
  const readSheet = async (body: Buffer) => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(body as never);
    const ws = wb.getWorksheet("Withdrawals")!;
    const headers = (ws.getRow(1).values as unknown[]).slice(1);
    const rows: Record<string, string>[] = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const vals = (row.values as unknown[]).slice(1);
      rows.push(Object.fromEntries(headers.map((h, i) => [String(h), vals[i] === undefined || vals[i] === null ? "" : String(vals[i])])));
    });
    return { rows, summary: wb.getWorksheet("Batch")! };
  };
  const binary = (r: import("supertest").Test) =>
    r.buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });

  it("exports every item with exact amounts, statuses and a summary sheet", async () => {
    const b = (await t.as(MAKER).get("/batches?status=completed_with_issues").expect(200)).body.data[0];
    const r = await binary(t.as(CHECKER).get(`/batches/${b.id}/items.xlsx`)).expect(200);
    expect(r.headers["content-type"]).toContain("spreadsheetml");
    expect(r.headers["content-disposition"]).toMatch(/batch-.*-withdrawals\.xlsx/);
    const { rows, summary } = await readSheet(r.body);
    expect(rows).toHaveLength(b.itemCount);
    const api = (await t.as(MAKER).get(`/batches/${b.id}/items?pageSize=200`).expect(200)).body.data;
    expect(rows.map((x) => [x.reference, x.amount, x.status])).toEqual(api.map((i: { reference: string; amount: string; status: string }) => [i.reference, i.amount, i.status]));
    expect(summary.getCell("B1").value).toBe(b.id);
    expect(summary.getCell("B6").value).toBe(b.totalAmount);
  });

  it("applies the same status/search filters as the table", async () => {
    const b = (await t.as(MAKER).get("/batches?status=completed_with_issues").expect(200)).body.data[0];
    const r = await binary(t.as(MAKER).get(`/batches/${b.id}/items.xlsx?status=succeeded`)).expect(200);
    const { rows } = await readSheet(r.body);
    expect(rows.length).toBe(b.paidCount);
    expect(rows.every((x) => x.status === "succeeded")).toBe(true);
    expect(r.headers["content-disposition"]).toContain("-succeeded.xlsx");
  });

  it("requires auth and a real batch", async () => {
    await t.http().get("/api/batches/00000000-0000-4000-8000-000000000000/items.xlsx").expect(401);
    await t.as(MAKER).get("/batches/00000000-0000-4000-8000-000000000000/items.xlsx").expect(404);
    await t.as(MAKER).get("/batches/00000000-0000-4000-8000-000000000000/items.xlsx?status=bogus").expect(422);
  });
});
