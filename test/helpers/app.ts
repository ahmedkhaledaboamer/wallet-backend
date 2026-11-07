import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createApiApp } from "../../src/app.module";
import { PAYOUT_QUEUE } from "../../src/domain/ports/payout-queue";
import { loadConfig } from "../../src/infrastructure/config/env";
import { DEMO_USERS } from "../../src/infrastructure/db/demo-users";
import type { InMemoryPayoutQueue } from "../../src/infrastructure/queue/in-memory.queue";
import { DB_HANDLE } from "../../src/core.module";
import type { DbHandle } from "../../src/infrastructure/db/client";

export const TOKENS = Object.fromEntries(DEMO_USERS.map((u) => [u.id, u.token])) as Record<string, string>;
export const MAKER = TOKENS.usr_sara_haddad!;
export const MAKER2 = TOKENS.usr_youssef_amin!;
export const CHECKER = TOKENS.usr_omar_khalil!;
export const EXECUTOR = TOKENS.usr_lina_mansour!;

/** Full API on PGlite (in memory) + in-memory queue + dry-run gateway; seeded demo data. */
export async function startTestApp(env: Record<string, string> = {}) {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_DRIVER: "pglite",
    PGLITE_DIR: "memory://",
    QUEUE_DRIVER: "memory",
    PAYOUTS_DRY_RUN: "true",
    DEMO_AUTH: "true",
    SEED_ON_BOOT: "true",
    DRY_RUN_MIN_DELAY_MS: "0",
    DRY_RUN_MAX_DELAY_MS: "0",
    DRY_RUN_CHAIN_CONFIRM_MS: "0",
    VERIFY_POLL_MS: "20",
    ...env,
  });
  const app: INestApplication = await createApiApp(config, { logger: false });
  await app.init();
  const queue = app.get<InMemoryPayoutQueue>(PAYOUT_QUEUE);
  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (url: string) => http().get(`/api${url}`).set("Authorization", `Bearer ${token}`),
    post: (url: string) => http().post(`/api${url}`).set("Authorization", `Bearer ${token}`),
  });
  return { app, config, queue, http, as, db: app.get<DbHandle>(DB_HANDLE), close: () => app.close() };
}
export type TestApp = Awaited<ReturnType<typeof startTestApp>>;
