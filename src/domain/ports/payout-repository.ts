import type { Amount } from "../amount";
import type { BatchStatus } from "../batch-status";
import type { ItemStatus } from "../item-status";
import type { Asset, Channel, Network, Role } from "../network";

export interface UserRecord {
  id: string;
  name: string;
  role: Role;
}

export interface BatchRecord {
  id: string;
  channel: Channel;
  status: BatchStatus;
  asset: Asset;
  network: Network;
  totalAmount: Amount;
  itemCount: number;
  paidCount: number;
  failedCount: number;
  reconciliationCount: number;
  fileSha256: string;
  fileName: string;
  createdBy: UserRecord;
  approvedBy?: UserRecord;
  executedBy?: UserRecord;
  rejectionReason?: string;
  txHash?: string;
  simulated: boolean;
  createdAt: Date;
  approvedAt?: Date;
  executedAt?: Date;
  completedAt?: Date;
}

export interface ItemRecord {
  id: string;
  batchId: string;
  rowNumber: number;
  reference: string;
  address: string;
  amount: Amount;
  memo?: string;
  status: ItemStatus;
  providerReference?: string;
  failureReason?: string;
  txHash?: string;
  attempts: number;
  /** True while a send to the provider is in flight (set before the call, cleared after). A crash leaves it true. */
  sending: boolean;
  processedAt?: Date;
}

export interface AuditRecord {
  id: string;
  batchId: string;
  action: string;
  actor?: UserRecord;
  context: Record<string, unknown>;
  createdAt: Date;
}

export interface NewBatch {
  id: string;
  channel: Channel;
  asset: Asset;
  network: Network;
  totalAmount: Amount;
  fileSha256: string;
  fileName: string;
  createdById: string;
  createdAt: Date;
  items: { id: string; rowNumber: number; reference: string; address: string; amount: Amount; memo?: string }[];
}

export interface Paged<T> {
  data: T[];
  total: number;
}

export interface BatchFilter {
  status?: BatchStatus;
  channel?: Channel;
  page: number;
  pageSize: number;
}
export interface ItemFilter {
  status?: ItemStatus;
  search?: string;
  page: number;
  pageSize: number;
}
export interface AuditFilter {
  batchId?: string;
  action?: string;
  page: number;
  pageSize: number;
}

export interface DashboardTotals {
  totalPaid: Amount;
  pendingApprovalCount: number;
  processingCount: number;
  needsReconciliationCount: number;
  byChannel: { channel: Channel; totalPaid: Amount; batchCount: number }[];
}

/** Operations available inside a transaction. Lock methods take a row lock (SELECT … FOR UPDATE). */
export interface PayoutRepositoryTx {
  lockBatch(id: string): Promise<BatchRecord | null>;
  updateBatch(id: string, patch: Partial<Omit<BatchRecord, "id" | "createdBy" | "approvedBy" | "executedBy">> & {
    approvedById?: string;
    executedById?: string;
  }): Promise<void>;
  /** Locks the item row; returns null if missing. */
  lockItem(id: string): Promise<ItemRecord | null>;
  updateItem(id: string, patch: Partial<Omit<ItemRecord, "id" | "batchId">>): Promise<void>;
  updateItemsByBatch(batchId: string, from: ItemStatus, patch: Partial<Omit<ItemRecord, "id" | "batchId">>): Promise<number>;
  countItemsByStatus(batchId: string): Promise<Record<ItemStatus, number>>;
  insertBatch(batch: NewBatch): Promise<void>;
  appendAudit(entry: AuditRecord | Omit<AuditRecord, "actor"> & { actorId?: string }): Promise<void>;
}

export interface PayoutRepository extends PayoutRepositoryTx {
  transaction<T>(fn: (tx: PayoutRepositoryTx) => Promise<T>): Promise<T>;

  findUserByTokenHash(tokenHash: string): Promise<UserRecord | null>;
  findBatch(id: string): Promise<BatchRecord | null>;
  /** Live (non-rejected) batch created from the same file, if any. */
  findActiveBatchByFileHash(sha256: string): Promise<BatchRecord | null>;
  listBatches(filter: BatchFilter): Promise<Paged<BatchRecord>>;
  listItems(batchId: string, filter: ItemFilter): Promise<Paged<ItemRecord>>;
  allItems(batchId: string): Promise<ItemRecord[]>;
  findItem(id: string): Promise<ItemRecord | null>;
  batchAudit(batchId: string): Promise<AuditRecord[]>;
  listAudit(filter: AuditFilter): Promise<Paged<AuditRecord>>;
  dashboard(): Promise<DashboardTotals>;
}
export const PAYOUT_REPOSITORY = Symbol("PayoutRepository");
