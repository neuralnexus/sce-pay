import { homedir } from "node:os";
import { join } from "node:path";

export type AppPaths = {
  rootDir: string;
  configFile: string;
  stateFile: string;
  auditFile: string;
  profileDir: string;
  lockFile: string;
};

function platformRoot(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string {
  const override = environment.SCE_PAY_HOME;
  if (override !== undefined && override.trim() !== "") {
    return override;
  }

  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "sce-pay");
  }

  if (platform === "win32") {
    return join(environment.APPDATA ?? join(homedir(), "AppData", "Roaming"), "sce-pay");
  }

  return join(environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "sce-pay");
}

export function resolveAppPaths(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): AppPaths {
  const rootDir = platformRoot(platform, environment);
  return {
    rootDir,
    configFile: join(rootDir, "config.json"),
    stateFile: join(rootDir, "state.json"),
    auditFile: join(rootDir, "audit.jsonl"),
    profileDir: join(rootDir, "browser-profile"),
    lockFile: join(rootDir, "run.lock"),
  };
}
