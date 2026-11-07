import { randomUUID } from "node:crypto";
import { monotonicFactory } from "ulid";
import type { Clock } from "../domain/ports/clock";
import type { IdGenerator } from "../domain/ports/id-generator";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class DefaultIdGenerator implements IdGenerator {
  private readonly ulid = monotonicFactory();
  batchId(): string {
    return randomUUID();
  }
  itemId(): string {
    return this.ulid();
  }
  auditId(): string {
    return this.ulid();
  }
}
