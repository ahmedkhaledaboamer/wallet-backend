// Writes two smoke-test workbooks to the directory given as argv[2].
import { writeFileSync } from "node:fs";
import path from "node:path";
import { buildWithdrawalWorkbook } from "../../src/infrastructure/xlsx/template";
import { tronAddress } from "./addresses";

const out = process.argv[2]!;
void (async () => {
  const good = [1, 2, 3].map((i) => ({ reference: `SMOKE-${i}`, address: tronAddress(100 + i), amount: `${i}0.25`, asset: "USDT", network: "TRC20" }));
  writeFileSync(path.join(out, "good.xlsx"), await buildWithdrawalWorkbook(good));
  writeFileSync(path.join(out, "bad.xlsx"), await buildWithdrawalWorkbook([...good, { reference: "SMOKE-1", address: "nope", amount: "abc", asset: "BTC", network: "TRC20" }]));
})();
