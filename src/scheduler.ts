import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { ScePayError } from "./errors.js";
import type { AppPaths } from "./paths.js";

const execFileAsync = promisify(execFile);

export type ScheduleArtifact = {
  path: string;
  content: string;
};

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function scheduleArtifacts(
  platform: NodeJS.Platform,
  paths: AppPaths,
  nodePath: string,
  cliPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): ScheduleArtifact[] {
  if (platform === "darwin") {
    const path = join(
      homedir(),
      "Library",
      "LaunchAgents",
      "com.neuralnexus.sce-pay.plist",
    );
    return [
      {
        path,
        content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.neuralnexus.sce-pay</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(cliPath)}</string>
    <string>run</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(join(paths.rootDir, "scheduler.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(paths.rootDir, "scheduler.err.log"))}</string>
</dict>
</plist>
`,
      },
    ];
  }

  if (platform === "linux") {
    const configRoot =
      environment.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    const servicePath = join(configRoot, "systemd", "user", "sce-pay.service");
    const timerPath = join(configRoot, "systemd", "user", "sce-pay.timer");
    return [
      {
        path: servicePath,
        content: `[Unit]
Description=Check and safely pay the current SCE bill
Documentation=https://github.com/neuralnexus/sce-pay

[Service]
Type=oneshot
ExecStart=${systemdArgument(nodePath)} ${systemdArgument(cliPath)} run
NoNewPrivileges=true
PrivateTmp=true
`,
      },
      {
        path: timerPath,
        content: `[Unit]
Description=Run sce-pay daily

[Timer]
OnCalendar=*-*-* 09:00:00
Persistent=true
RandomizedDelaySec=15m
Unit=sce-pay.service

[Install]
WantedBy=timers.target
`,
      },
    ];
  }

  throw new ScePayError(
    "UNSUPPORTED_PLATFORM",
    `Automatic scheduler installation is not implemented for ${platform}.`,
    { remediation: "Run `sce-pay run` daily with your operating system's scheduler." },
  );
}

export async function installSchedule(
  platform: NodeJS.Platform,
  paths: AppPaths,
  nodePath: string,
  cliPath: string,
): Promise<ScheduleArtifact[]> {
  const artifacts = scheduleArtifacts(platform, paths, nodePath, cliPath);
  for (const artifact of artifacts) {
    await mkdir(dirname(artifact.path), { recursive: true, mode: 0o700 });
    await writeFile(artifact.path, artifact.content, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  if (platform === "darwin") {
    const domain = `gui/${process.getuid?.() ?? 0}`;
    await execFileAsync("launchctl", ["bootout", domain, artifacts[0]?.path ?? ""]).catch(
      () => undefined,
    );
    await execFileAsync("launchctl", [
      "bootstrap",
      domain,
      artifacts[0]?.path ?? "",
    ]);
  } else if (platform === "linux") {
    await execFileAsync("systemctl", ["--user", "daemon-reload"]);
    await execFileAsync("systemctl", [
      "--user",
      "enable",
      "--now",
      "sce-pay.timer",
    ]);
  }

  return artifacts;
}

export async function removeSchedule(
  platform: NodeJS.Platform,
  paths: AppPaths,
  nodePath: string,
  cliPath: string,
): Promise<ScheduleArtifact[]> {
  const artifacts = scheduleArtifacts(platform, paths, nodePath, cliPath);
  if (platform === "darwin") {
    const domain = `gui/${process.getuid?.() ?? 0}`;
    await execFileAsync("launchctl", ["bootout", domain, artifacts[0]?.path ?? ""]).catch(
      () => undefined,
    );
  } else if (platform === "linux") {
    await execFileAsync("systemctl", [
      "--user",
      "disable",
      "--now",
      "sce-pay.timer",
    ]).catch(() => undefined);
  }

  for (const artifact of artifacts) {
    await rm(artifact.path, { force: true });
  }
  if (platform === "linux") {
    await execFileAsync("systemctl", ["--user", "daemon-reload"]).catch(
      () => undefined,
    );
  }
  return artifacts;
}
