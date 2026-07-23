import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  configSchema,
  defaultConfig,
  initializeConfig,
  loadConfig,
} from "../src/config.js";
import type { AppPaths } from "../src/paths.js";

function appPaths(rootDir: string): AppPaths {
  return {
    rootDir,
    configFile: join(rootDir, "config.json"),
    stateFile: join(rootDir, "state.json"),
    auditFile: join(rootDir, "audit.jsonl"),
    profileDir: join(rootDir, "profile"),
    lockFile: join(rootDir, "run.lock"),
  };
}

test("configuration initializes disabled and round trips", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "sce-pay-config-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const paths = appPaths(root);

  await initializeConfig(paths, false);
  const config = await loadConfig(paths);
  assert.equal(config.automation.enabled, false);
  assert.equal(config.automation.mode, "observe");
  assert.equal(config.automation.expectedFeeCents, 165);
  assert.equal(
    config.startUrl,
    "https://www.sce.com/mysce/billsnpayments/paybills",
  );
  assert.deepEqual(config.allowedHosts, ["www.sce.com"]);

  if (process.platform !== "win32") {
    const mode = (await stat(paths.configFile)).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test("host allowlist schema rejects protocols and public-suffix wildcards", () => {
  assert.throws(() =>
    configSchema.parse({
      ...defaultConfig(),
      allowedHosts: ["*.com"],
    }),
  );
  assert.throws(() =>
    configSchema.parse({
      ...defaultConfig(),
      allowedHosts: ["https://sce.com"],
    }),
  );
  assert.doesNotThrow(() =>
    configSchema.parse({
      ...defaultConfig(),
      allowedHosts: ["sce.com", "*.sce.com"],
    }),
  );
});
