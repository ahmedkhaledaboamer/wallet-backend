import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Amount } from "../../src/domain/amount";
import type { PayoutRequest } from "../../src/domain/ports/payout-gateway";
import { MexcClient } from "../../src/infrastructure/mexc/mexc.client";
import { MexcPayoutGateway } from "../../src/infrastructure/mexc/mexc-payout.gateway";

const SECRET = "test-secret";
const NOW = 1_762_500_000_000;
const codes = { TRC20: "TRX", BEP20: "BSC", ERC20: "ETH" } as const;

const req: PayoutRequest = {
  itemId: "01JC0000000000000000000000",
  reference: "WD-2026-0001",
  address: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj",
  amount: Amount.parse("125.50"),
  asset: "USDT",
  network: "TRC20",
};

function setup(respond: () => Promise<Response> | Response) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => respond());
  const client = new MexcClient({
    baseUrl: "https://api.mexc.com",
    apiKey: "key-123",
    apiSecret: SECRET,
    timeoutMs: 50,
    recvWindowMs: 5000,
    now: () => NOW,
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { gateway: new MexcPayoutGateway(client, codes), fetchMock };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const netError = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });

describe("MexcPayoutGateway — signed request", () => {
  it("sends exactly the signed POST /api/v3/capital/withdraw", async () => {
    const { gateway, fetchMock } = setup(() => json(200, { id: "mx-778899" }));
    const out = await gateway.send(req);
    expect(out).toEqual({ status: "accepted", providerReference: "mx-778899" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    const expectedQuery =
      "coin=USDT&withdrawOrderId=01JC0000000000000000000000&netWork=TRX&address=TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj" +
      `&amount=125.5&remark=WD-2026-0001&recvWindow=5000&timestamp=${NOW}`;
    const signature = createHmac("sha256", SECRET).update(expectedQuery).digest("hex");
    expect(url).toBe(`https://api.mexc.com/api/v3/capital/withdraw?${expectedQuery}&signature=${signature}`);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["X-MEXC-APIKEY"]).toBe("key-123");
  });

  it("includes memo when present and maps networks from config", async () => {
    const { gateway, fetchMock } = setup(() => json(200, { id: "1" }));
    await gateway.send({ ...req, network: "BEP20", address: "0x8ba1f109551bD432803012645Ac136ddd64DBA72", memo: "tag-9" });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("netWork=BSC");
    expect(url).toContain("memo=tag-9");
  });
});

describe("MexcPayoutGateway — outcome classification", () => {
  it.each([
    ["ECONNREFUSED", "retryable"],
    ["ENOTFOUND", "retryable"],
    ["EAI_AGAIN", "retryable"],
    ["ECONNRESET", "unknown"], // the request may have been delivered
  ])("network error %s → %s", async (code, status) => {
    const { gateway } = setup(() => Promise.reject(netError(code)));
    expect((await gateway.send(req)).status).toBe(status);
  });

  it("timeout after send → unknown (never retried)", async () => {
    const { gateway } = setup(
      () =>
        new Promise<Response>((_, reject) => {
          setTimeout(() => reject(new DOMException("aborted", "AbortError")), 80);
        }),
    );
    const out = await gateway.send(req);
    expect(out.status).toBe("unknown");
  });

  it("429 → retryable with Retry-After", async () => {
    const { gateway } = setup(() => json(429, { code: 429, msg: "Too many requests" }, { "retry-after": "3" }));
    expect(await gateway.send(req)).toEqual({ status: "retryable", reason: "MEXC rate limit (429)", retryAfterMs: 3000 });
  });

  it.each([400, 401, 403, 404, 422])("%i → rejected (failed)", async (status) => {
    const { gateway } = setup(() => json(status, { code: 30004, msg: "Insufficient balance" }));
    const out = await gateway.send(req);
    expect(out.status).toBe("rejected");
    expect(out).toMatchObject({ providerCode: "30004" });
    if (out.status === "rejected") expect(out.reason).toContain("Insufficient balance");
  });

  it.each([500, 502, 503, 504])("%i → unknown (requires reconciliation)", async (status) => {
    const { gateway } = setup(() => json(status, { msg: "oops" }));
    expect((await gateway.send(req)).status).toBe("unknown");
  });

  it("2xx without an id → unknown", async () => {
    const { gateway } = setup(() => json(200, { success: true }));
    expect((await gateway.send(req)).status).toBe("unknown");
  });

  it("2xx with a non-JSON body → unknown", async () => {
    const { gateway } = setup(() => new Response("<html>ok</html>", { status: 200 }));
    expect((await gateway.send(req)).status).toBe("unknown");
  });
});
