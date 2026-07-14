import { rm } from "node:fs/promises";

export default async function globalTeardown() {
  const stateDir = String(process.env.PLAYWRIGHT_D1_STATE_DIR || "");
  if (!stateDir.includes("old-prague-playwright-d1-")) return;
  await rm(stateDir, { recursive: true, force: true });
}
