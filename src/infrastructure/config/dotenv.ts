import { existsSync } from "node:fs";
import path from "node:path";

/** Loads backend/.env into process.env (existing variables win). Uses Node's built-in parser. */
export function loadDotEnv(file = path.resolve(__dirname, "../../..", ".env")) {
  if (existsSync(file)) process.loadEnvFile(file);
}
