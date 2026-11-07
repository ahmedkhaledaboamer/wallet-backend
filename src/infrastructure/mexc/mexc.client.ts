/**
 * Minimal MEXC Spot v3 client for signed endpoints.
 * Signature = HMAC-SHA256(secret, <exact query string>) as lowercase hex, appended as `signature`.
 * Docs: https://mexcdevelop.github.io/apidocs/spot_v3_en/#withdraw-new
 */
import { createHmac } from "node:crypto";

export interface MexcCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface MexcClientOptions extends MexcCredentials {
  baseUrl: string;
  timeoutMs: number;
  recvWindowMs: number;
  now?: () => number;
  fetch?: typeof fetch;
}

export type MexcResponse =
  | { kind: "http"; status: number; body: unknown; retryAfterMs?: number }
  /** The request was never delivered (DNS failure, connection refused…). Safe to retry. */
  | { kind: "not_sent"; reason: string }
  /** Timed out / connection dropped after the request may have reached MEXC. NOT safe to retry. */
  | { kind: "maybe_sent"; reason: string };

/** Errors that prove the request never left this machine. */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ERR_INVALID_URL", "UND_ERR_CONNECT_TIMEOUT"]);

function errorCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const c = cur as { code?: unknown; cause?: unknown };
    if (typeof c.code === "string") return c.code;
    cur = c.cause;
  }
  return undefined;
}

export function signQuery(query: string, secret: string): string {
  return createHmac("sha256", secret).update(query).digest("hex");
}

export class MexcClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: MexcClientOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Builds the exact signed query string (exposed for tests and debugging). */
  signedQuery(params: Record<string, string | undefined>): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.append(k, v);
    q.append("recvWindow", String(this.opts.recvWindowMs));
    q.append("timestamp", String(this.now()));
    const query = q.toString();
    return `${query}&signature=${signQuery(query, this.opts.apiSecret)}`;
  }

  async signedRequest(method: "GET" | "POST", path: string, params: Record<string, string | undefined>): Promise<MexcResponse> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}${path}?${this.signedQuery(params)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("MEXC request timed out")), this.opts.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers: { "X-MEXC-APIKEY": this.opts.apiKey, "Content-Type": "application/json" },
        signal: ctrl.signal,
      });
    } catch (e) {
      const code = errorCode(e);
      if (code && NOT_SENT_CODES.has(code)) return { kind: "not_sent", reason: `${code}: ${e instanceof Error ? e.message : String(e)}` };
      // AbortError (our timeout), ECONNRESET, socket hang up, unknown → the withdrawal may exist.
      return { kind: "maybe_sent", reason: ctrl.signal.aborted ? `Timed out after ${this.opts.timeoutMs} ms` : `${code ?? "network error"}: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      clearTimeout(timer);
    }

    let body: unknown = undefined;
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text.slice(0, 500) };
      }
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    return { kind: "http", status: res.status, body, retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined };
  }
}
