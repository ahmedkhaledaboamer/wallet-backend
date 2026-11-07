import { NotFoundError } from "../domain/errors";
import type {
  AuditFilter,
  AuditRecord,
  BatchFilter,
  BatchRecord,
  DashboardTotals,
  ItemFilter,
  ItemRecord,
  Paged,
  PayoutRepository,
} from "../domain/ports/payout-repository";

export class PayoutQueries {
  constructor(private readonly repo: PayoutRepository) {}

  dashboard(): Promise<DashboardTotals> {
    return this.repo.dashboard();
  }

  listBatches(filter: BatchFilter): Promise<Paged<BatchRecord>> {
    return this.repo.listBatches(filter);
  }

  async getBatch(id: string): Promise<BatchRecord> {
    const b = await this.repo.findBatch(id);
    if (!b) throw new NotFoundError("Batch", id);
    return b;
  }

  async listItems(batchId: string, filter: ItemFilter): Promise<{ batch: BatchRecord; page: Paged<ItemRecord> }> {
    const batch = await this.getBatch(batchId);
    return { batch, page: await this.repo.listItems(batchId, filter) };
  }

  async batchAudit(batchId: string): Promise<AuditRecord[]> {
    await this.getBatch(batchId);
    return this.repo.batchAudit(batchId);
  }

  listAudit(filter: AuditFilter): Promise<Paged<AuditRecord>> {
    return this.repo.listAudit(filter);
  }
}
