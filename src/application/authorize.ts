import { ForbiddenError, NotFoundError, PolicyViolationError } from "../domain/errors";
import type { Channel, Role } from "../domain/network";
import type { BatchRecord, UserRecord } from "../domain/ports/payout-repository";

/** Defence in depth: use cases re-check roles even though the HTTP RolesGuard already did. */
export function assertRole(actor: UserRecord, ...roles: Role[]) {
  if (!roles.includes(actor.role)) {
    throw new ForbiddenError(`This action requires the ${roles.join(" or ")} role; you are ${actor.role}.`);
  }
}

export function requireBatch(batch: BatchRecord | null, id: string): BatchRecord {
  if (!batch) throw new NotFoundError("Batch", id);
  return batch;
}

export function assertChannel(batch: BatchRecord, channel: Channel, message: string) {
  if (batch.channel !== channel) throw new PolicyViolationError("CHANNEL_MISMATCH", message);
}
