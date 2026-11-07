import { z } from "zod";
import { BATCH_STATUSES } from "../../domain/batch-status";
import { ValidationError } from "../../domain/errors";
import { ITEM_STATUSES } from "../../domain/item-status";
import { CHANNELS } from "../../domain/network";

const emptyToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);
const pageNo = z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).default(1));
const size = (def: number) => z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(200).default(def));

export const batchListQuery = z.object({
  status: z.preprocess(emptyToUndefined, z.enum(BATCH_STATUSES).optional()),
  channel: z.preprocess(emptyToUndefined, z.enum(CHANNELS).optional()),
  page: pageNo,
  pageSize: size(20),
});

export const itemListQuery = z.object({
  status: z.preprocess(emptyToUndefined, z.enum(ITEM_STATUSES).optional()),
  search: z.preprocess(emptyToUndefined, z.string().max(200).optional()),
  page: pageNo,
  pageSize: size(50),
});

export const auditListQuery = z.object({
  batchId: z.preprocess(emptyToUndefined, z.string().max(100).optional()),
  action: z.preprocess(emptyToUndefined, z.string().max(100).optional()),
  page: pageNo,
  pageSize: size(50),
});

export const channelField = z.enum(CHANNELS, { message: "channel must be mexc or trust_wallet" });
export const uuidParam = z.uuid();

/** Parses or throws 422 { code: VALIDATION_FAILED }. */
export function parseOr422<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const detail = r.error.issues.map((i) => `${i.path.join(".") || what}: ${i.message}`).join("; ");
    throw new ValidationError(`Invalid ${what}: ${detail}`);
  }
  return r.data;
}
