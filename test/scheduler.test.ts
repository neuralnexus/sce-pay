import assert from "node:assert/strict";
import test from "node:test";

import type { AppPaths } from "../src/paths.js";
import { scheduleArtifacts } from "../src/scheduler.js";

const paths: AppPaths = {
  rootDir: "/tmp/sce pay",
  configFile: "/tmp/sce pay/config.json",
  stateFile: "/tmp/sce pay/state.json",
  auditFile: "/tmp/sce pay/audit.jsonl",
  profileDir: "/tmp/sce pay/profile",
  lockFile: "/tmp/sce pay/run.lock",
};

test("macOS schedule runs daily as the current user", () => {
  const [artifact] = scheduleArtifacts(
    "darwin",
    paths,
    "/usr/local/bin/node",
    "/opt/sce-pay/dist/cli.js",
  );
  assert.ok(artifact);
  assert.match(artifact.path, /LaunchAgents/);
  assert.match(artifact.content, /<integer>9<\/integer>/);
  assert.match(artifact.content, /<string>run<\/string>/);
  assert.doesNotMatch(artifact.content, /credit|password|last4/i);
});

test("Linux schedule is a persistent user timer", () => {
  const artifacts = scheduleArtifacts(
    "linux",
    paths,
    "/usr/bin/node",
    "/opt/sce-pay/dist/cli.js",
    { XDG_CONFIG_HOME: "/tmp/config" },
  );
  assert.equal(artifacts.length, 2);
  assert.match(artifacts[0]?.content ?? "", /NoNewPrivileges=true/);
  assert.match(artifacts[1]?.content ?? "", /Persistent=true/);
  assert.match(artifacts[1]?.content ?? "", /RandomizedDelaySec=15m/);
});
