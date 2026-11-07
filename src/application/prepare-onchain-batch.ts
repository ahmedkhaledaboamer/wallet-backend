import { uuidToBatchRef } from "../domain/batch-ref";
import { AmountError } from "../domain/amount";
import { IllegalStateError, PolicyViolationError } from "../domain/errors";
import { isEvmNetwork } from "../domain/network";
import type { PayoutRepository, UserRecord } from "../domain/ports/payout-repository";
import { assertChannel, assertRole, requireBatch } from "./authorize";
import type { AppSettings, OnchainNetwork } from "./settings";

/** Contract shape of GET /batches/:id/onchain-payload. amounts/total are RAW BASE UNITS (integer strings). */
export interface OnchainPayloadDto {
  chainId: number;
  contract: string;
  token: string;
  tokenDecimals: number;
  treasury: string;
  batchRef: string;
  recipients: string[];
  amounts: string[];
  total: string;
}

export function onchainNetworkFor(settings: AppSettings, network: string): OnchainNetwork {
  const cfg = isEvmNetwork(network) ? settings.onchain[network] : undefined;
  if (!cfg) throw new PolicyViolationError("UNSUPPORTED_NETWORK", `No on-chain configuration for ${network}.`);
  return cfg;
}

export class PrepareOnchainBatch {
  constructor(
    private readonly repo: PayoutRepository,
    private readonly settings: AppSettings,
  ) {}

  async execute(actor: UserRecord, batchId: string): Promise<OnchainPayloadDto> {
    assertRole(actor, "executor");
    const batch = requireBatch(await this.repo.findBatch(batchId), batchId);
    assertChannel(batch, "trust_wallet", "On-chain payloads exist only for Trust Wallet batches.");
    if (batch.status !== "approved") {
      throw new IllegalStateError(`Batch ${batchId} is ${batch.status}; only approved batches can be signed.`);
    }
    const net = onchainNetworkFor(this.settings, batch.network);
    const items = await this.repo.allItems(batchId);

    try {
      const amounts = items.map((i) => i.amount.toBaseUnits(net.tokenDecimals));
      const total = batch.totalAmount.toBaseUnits(net.tokenDecimals);
      if (amounts.reduce((a, b) => a + b, 0n) !== total) {
        throw new IllegalStateError("Item amounts don't add up to the batch total.", "INTEGRITY_ERROR");
      }
      return {
        chainId: net.chainId,
        contract: net.contract,
        token: net.token,
        tokenDecimals: net.tokenDecimals,
        treasury: net.treasury,
        batchRef: uuidToBatchRef(batch.id),
        recipients: items.map((i) => i.address),
        amounts: amounts.map(String),
        total: total.toString(),
      };
    } catch (e) {
      if (e instanceof AmountError) {
        throw new PolicyViolationError("TOKEN_PRECISION", `An amount has more decimals than the token supports (${net.tokenDecimals}).`);
      }
      throw e;
    }
  }
}
