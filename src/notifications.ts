import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function escapeAppleScript(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export async function notifyDesktop(
  title: string,
  message: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  try {
    if (platform === "darwin") {
      await execFileAsync("osascript", [
        "-e",
        `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`,
      ]);
      return;
    }

    if (platform === "linux") {
      await execFileAsync("notify-send", [title, message]);
    }
  } catch {
    // Notifications are best effort and must never alter payment state.
  }
}
