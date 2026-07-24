#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface, emitKeypressEvents } from "node:readline";

import type { BrowserContextOptions } from "@cloudflare/playwright";
import { type Browser, chromium, type Frame, type Page } from "playwright-core";

import { validateGuestBundle } from "./bundle.js";
import { encryptBundle, generateBundleKey } from "./crypto.js";
import { formatCents, parseMoneyToCents } from "./money.js";
import {
  isAllowedSceTopLevelUrl,
  normalizedOrigin,
  SCE_GUEST_ORIGIN,
} from "./origins.js";
import { extractDisplayedCardLast4 } from "./parsing.js";

const DEFAULT_GUEST_URL = "https://www.sce.com/mysce/billsnpayments/paybills";
const CONTROL_FILE = resolve(process.cwd(), ".sce-pay/control.json");

interface ControlConfig {
  workerUrl: string;
  adminToken: string;
}

function lineQuestion(question: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveAnswer) => {
    reader.question(question, (answer) => {
      reader.close();
      resolveAnswer(answer.trim());
    });
  });
}

async function requiredQuestion(question: string): Promise<string> {
  while (true) {
    const answer = await lineQuestion(question);
    if (answer) return answer;
    process.stdout.write("A value is required.\n");
  }
}

async function hiddenQuestion(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error("Sensitive onboarding prompts require an interactive terminal.");
  }
  process.stdout.write(question);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolveAnswer, reject) => {
    let value = "";
    const onKeypress = (
      character: string,
      key: { name?: string; ctrl?: boolean; sequence?: string },
    ): void => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Setup cancelled."));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        process.stdout.write("\n");
        resolveAnswer(value.trim());
        return;
      }
      if (key.name === "backspace") {
        value = value.slice(0, -1);
        return;
      }
      if (character && !key.ctrl) value += character;
    };
    const cleanup = (): void => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on("keypress", onKeypress);
  });
}

function askInteger(
  question: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): Promise<number> {
  return lineQuestion(`${question} [${defaultValue}]: `).then((answer) => {
    const value = answer ? Number.parseInt(answer, 10) : defaultValue;
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${question} must be between ${minimum} and ${maximum}.`);
    }
    return value;
  });
}

async function askMoney(question: string, defaultValue: string): Promise<number> {
  const answer = await lineQuestion(`${question} [${defaultValue}]: `);
  return parseMoneyToCents(answer || defaultValue);
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

async function captureSessionStorage(
  frames: Frame[],
): Promise<Record<string, Record<string, string>>> {
  const result: Record<string, Record<string, string>> = {};
  for (const frame of frames) {
    const origin = normalizedOrigin(frame.url());
    if (!origin) continue;
    const values = await frame
      .evaluate(() => Object.fromEntries(Object.entries(sessionStorage)))
      .catch(() => undefined);
    if (values && Object.keys(values).length > 0) result[origin] = values;
  }
  return result;
}

async function launchCalibration(): Promise<{
  browser: Browser;
  page: Page;
  topLevelOrigins: Set<string>;
  requestOrigins: Set<string>;
}> {
  let browser: Browser;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: false });
  } catch (error) {
    throw new Error(
      "Google Chrome is required for the one-time local calibration. Install Chrome and rerun setup.",
      { cause: error },
    );
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  const topLevelOrigins = new Set<string>();
  const requestOrigins = new Set<string>();
  context.on("request", (request) => {
    const origin = normalizedOrigin(request.url());
    if (origin) requestOrigins.add(origin);
  });
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const origin = normalizedOrigin(frame.url());
    if (origin) topLevelOrigins.add(origin);
  });
  await page.goto(DEFAULT_GUEST_URL, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  return { browser, page, topLevelOrigins, requestOrigins };
}

async function calibrate(): Promise<{
  storageState: NonNullable<BrowserContextOptions["storageState"]>;
  sessionStorageByOrigin: Record<string, Record<string, string>>;
  allowedTopLevelOrigins: string[];
  allowedFrameOrigins: string[];
  allowedRequestOrigins: string[];
  paymentMethodLast4: string;
}> {
  process.stdout.write(
    [
      "",
      "A Chrome window will open on SCE.",
      "Choose Guest Pay and go through the guest card flow until the final review page.",
      "Enter card details only in SCE's page. Do not submit the payment.",
      "Return here once the amount, fee, total, and card ending digits are visible.",
      "",
    ].join("\n"),
  );
  const { browser, page, topLevelOrigins, requestOrigins } = await launchCalibration();
  try {
    await requiredQuestion("Press Enter when the final review page is visible: ");
    if (
      !isAllowedSceTopLevelUrl(page.url()) ||
      [...topLevelOrigins].some((origin) => origin !== SCE_GUEST_ORIGIN)
    ) {
      throw new Error(
        "The reviewed flow left SCE's current Guest Pay application. External legacy payment portals are not supported.",
      );
    }
    const context = page.context();
    const storageState = (await context.storageState({
      indexedDB: true,
    })) as NonNullable<BrowserContextOptions["storageState"]>;
    const frames = page.frames();
    const sessionStorageByOrigin = await captureSessionStorage(frames);
    const frameOrigins = unique(
      frames
        .filter((frame) => frame !== page.mainFrame())
        .map((frame) => normalizedOrigin(frame.url()))
        .filter((origin): origin is string => origin !== null),
    ).filter((origin) => !topLevelOrigins.has(origin));
    const topOrigins = unique(topLevelOrigins);
    if (topOrigins.length !== 1 || topOrigins[0] !== SCE_GUEST_ORIGIN) {
      throw new Error("The SCE Guest Pay top-level origin was not captured.");
    }
    const requestOriginList = unique([
      ...requestOrigins,
      ...topOrigins,
      ...frameOrigins,
    ]);
    const reviewText = (
      await Promise.all(
        frames.map((frame) =>
          frame
            .locator("body")
            .innerText()
            .catch(() => ""),
        ),
      )
    )
      .filter(Boolean)
      .join("\n\n");
    const paymentMethodLast4 = extractDisplayedCardLast4(reviewText);

    process.stdout.write("\nOrigins observed during your reviewed payment flow:\n");
    for (const origin of topOrigins) process.stdout.write(`  top-level: ${origin}\n`);
    for (const origin of frameOrigins)
      process.stdout.write(`  payment frame: ${origin}\n`);
    for (const origin of requestOriginList) {
      if (!topOrigins.includes(origin) && !frameOrigins.includes(origin)) {
        process.stdout.write(`  network dependency: ${origin}\n`);
      }
    }
    const approved = await lineQuestion(
      "Approve exactly these HTTPS origins for monthly runs? [y/N]: ",
    );
    if (!/^y(?:es)?$/i.test(approved)) throw new Error("Origin approval declined.");
    return {
      storageState,
      sessionStorageByOrigin,
      allowedTopLevelOrigins: topOrigins,
      allowedFrameOrigins: frameOrigins,
      allowedRequestOrigins: requestOriginList,
      paymentMethodLast4,
    };
  } finally {
    await browser.close();
  }
}

function wrangler(
  args: string[],
  options?: { input?: string; showOutput?: boolean },
): string {
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(executable, ["wrangler", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: options?.input,
    stdio: options?.showOutput ? ["pipe", "inherit", "inherit"] : "pipe",
    env: {
      ...process.env,
      npm_config_cache: resolve(process.cwd(), ".npm-cache"),
    },
  });
  if (result.status !== 0) {
    const detail =
      typeof result.stderr === "string" && result.stderr.trim()
        ? result.stderr.trim()
        : "Wrangler exited unsuccessfully.";
    throw new Error(detail);
  }
  return typeof result.stdout === "string" ? result.stdout : "";
}

function deploymentUrl(output: string): string | undefined {
  return output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/i)?.[0];
}

async function requestApi(
  control: ControlConfig,
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(`${control.workerUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${control.adminToken}`,
      "content-type": "application/json",
      ...init?.headers,
    },
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error("Worker response was too large.");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("Worker returned an invalid response.");
  }
  return { response, body };
}

async function saveControl(control: ControlConfig): Promise<void> {
  await mkdir(dirname(CONTROL_FILE), { recursive: true, mode: 0o700 });
  await writeFile(CONTROL_FILE, `${JSON.stringify(control, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function loadControl(): Promise<ControlConfig> {
  try {
    const control = JSON.parse(await readFile(CONTROL_FILE, "utf8")) as ControlConfig;
    const url = new URL(control.workerUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !/^[A-Za-z0-9_-]{43}$/.test(control.adminToken)
    ) {
      throw new Error("invalid control data");
    }
    return control;
  } catch {
    throw new Error("Local control data is missing. Run `npm run setup` first.");
  }
}

async function doctor(): Promise<void> {
  const major = Number.parseInt(process.versions.node.split(".", 1)[0] ?? "0", 10);
  if (major < 22) throw new Error("Node.js 22 or newer is required.");
  wrangler(["whoami"]);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch (error) {
    throw new Error("Google Chrome is required for onboarding.", { cause: error });
  } finally {
    await browser?.close();
  }
  process.stdout.write(
    "Preflight passed: Node, Wrangler authentication, and Chrome are ready.\n",
  );
}

async function setup(): Promise<void> {
  process.stdout.write(
    [
      "SCE Pay cloud onboarding",
      "This is a one-time local calibration. Monthly runs happen in Cloudflare.",
      "The Worker uses SCE Guest Pay, not your SCE login.",
      "",
    ].join("\n"),
  );
  await doctor();

  const capture = await calibrate();
  const accountNumber = (await hiddenQuestion("SCE customer account number: ")).replace(
    /\D/g,
    "",
  );
  const mailingZip = await hiddenQuestion("5-digit SCE mailing ZIP: ");
  const paymentMethodLast4 = capture.paymentMethodLast4;
  process.stdout.write(
    `Verified the reviewed payment method ending in ${paymentMethodLast4}.\n`,
  );
  const maxBillCents = await askMoney("Maximum SCE bill", "750.00");
  const feeLimitCentsExclusive = await askMoney("Fee must stay below", "4.00");
  if (feeLimitCentsExclusive > 400) {
    throw new Error("The fee ceiling may not exceed $4.00.");
  }
  const payWhenDueWithinDays = await askInteger(
    "Pay when due within this many days",
    14,
    0,
    31,
  );
  const notificationWebhookUrl = await lineQuestion(
    "Optional HTTPS notification webhook (blank to skip): ",
  );
  const notificationWebhookSecret = notificationWebhookUrl
    ? randomBytes(32).toString("base64url")
    : undefined;

  const bundle = validateGuestBundle({
    version: 2,
    configurationId: randomBytes(16).toString("base64url"),
    capturedAt: new Date().toISOString(),
    guestUrl: DEFAULT_GUEST_URL,
    accountNumber,
    mailingZip,
    paymentMethodLast4,
    maxBillCents,
    feeLimitCentsExclusive,
    payWhenDueWithinDays,
    allowedTopLevelOrigins: capture.allowedTopLevelOrigins,
    allowedFrameOrigins: capture.allowedFrameOrigins,
    allowedRequestOrigins: capture.allowedRequestOrigins,
    storageState: capture.storageState,
    sessionStorageByOrigin: capture.sessionStorageByOrigin,
    ...(notificationWebhookUrl ? { notificationWebhookUrl } : {}),
    ...(notificationWebhookSecret ? { notificationWebhookSecret } : {}),
  });

  const bundleKey = generateBundleKey();
  const adminToken = randomBytes(32).toString("base64url");
  const encrypted = await encryptBundle(bundle, bundleKey);
  process.stdout.write("\nDeploying the disarmed Worker...\n");
  await mkdir(resolve(process.cwd(), ".sce-pay"), {
    recursive: true,
    mode: 0o700,
  });
  const secretDirectory = await mkdtemp(
    resolve(process.cwd(), ".sce-pay/deploy-secrets-"),
  );
  const secretsFile = resolve(secretDirectory, "secrets.json");
  await writeFile(
    secretsFile,
    JSON.stringify({ BUNDLE_KEY: bundleKey, ADMIN_TOKEN: adminToken }),
    { mode: 0o600 },
  );
  let deployOutput: string;
  try {
    deployOutput = wrangler(["deploy", "--secrets-file", secretsFile]);
  } finally {
    await rm(secretDirectory, { recursive: true, force: true });
  }
  process.stdout.write(deployOutput);
  let workerUrl = deploymentUrl(deployOutput);
  if (!workerUrl) {
    workerUrl = await requiredQuestion(
      "Wrangler did not print a workers.dev URL. Enter the deployed Worker URL: ",
    );
  }
  const parsedWorkerUrl = new URL(workerUrl);
  if (
    parsedWorkerUrl.protocol !== "https:" ||
    parsedWorkerUrl.username ||
    parsedWorkerUrl.password
  ) {
    throw new Error("The deployed Worker URL must be credential-free HTTPS.");
  }
  workerUrl = `${parsedWorkerUrl.origin}${parsedWorkerUrl.pathname}`.replace(
    /\/+$/u,
    "",
  );

  const control = { workerUrl, adminToken };
  await saveControl(control);
  const uploaded = await requestApi(control, "/api/setup", {
    method: "POST",
    body: JSON.stringify(encrypted),
  });
  if (!uploaded.response.ok) {
    throw new Error("The encrypted onboarding bundle was not accepted by the Worker.");
  }
  process.stdout.write("Running a cloud dry run before arming...\n");
  const dryRun = await requestApi(control, "/api/run", {
    method: "POST",
    body: JSON.stringify({ source: "manual", dryRun: true }),
  });
  process.stdout.write(`${JSON.stringify(dryRun.body, null, 2)}\n`);
  if (!dryRun.response.ok) {
    process.stdout.write(
      "The Worker remains disarmed. Fix the reported guest-session or page issue, then rerun setup.\n",
    );
    return;
  }
  const armed = await requestApi(control, "/api/arm", {
    method: "POST",
    body: "{}",
  });
  if (!armed.response.ok)
    throw new Error("Dry run passed, but the Worker could not be armed.");
  process.stdout.write(
    [
      "",
      "Setup complete.",
      `Worker: ${workerUrl}`,
      `Bill ceiling: ${formatCents(maxBillCents)}`,
      `Fee rule: less than ${formatCents(feeLimitCentsExclusive)}`,
      ...(notificationWebhookSecret
        ? [`Webhook signing secret (save this now): ${notificationWebhookSecret}`]
        : []),
      "Cloudflare Cron checks once daily; your computer is no longer involved.",
      "",
    ].join("\n"),
  );
}

async function controlCommand(command: string, args: string[]): Promise<void> {
  const control = await loadControl();
  let path = "/api/status";
  let init: RequestInit = { method: "GET" };
  if (command === "dry-run") {
    path = "/api/run";
    init = {
      method: "POST",
      body: JSON.stringify({ source: "manual", dryRun: true }),
    };
  } else if (command === "run") {
    if (!args.includes("--yes")) {
      throw new Error("A manual real payment requires `sce-pay run --yes`.");
    }
    path = "/api/run";
    init = {
      method: "POST",
      body: JSON.stringify({ source: "manual", dryRun: false }),
    };
  } else if (command === "arm") {
    const validation = await requestApi(control, "/api/run", {
      method: "POST",
      body: JSON.stringify({ source: "manual", dryRun: true }),
    });
    process.stdout.write(`${JSON.stringify(validation.body, null, 2)}\n`);
    if (!validation.response.ok) {
      process.exitCode = 1;
      return;
    }
    path = "/api/arm";
    init = { method: "POST", body: "{}" };
  } else if (command === "disarm") {
    path = `/api/${command}`;
    init = { method: "POST", body: "{}" };
  } else if (command === "reconcile") {
    const intentId = args[0];
    const result = args[1] as "paid" | "not-paid" | undefined;
    const note = args.slice(2).join(" ");
    if (!intentId || !["paid", "not-paid"].includes(result ?? "") || !note) {
      throw new Error(
        'Usage: sce-pay reconcile INTENT_ID paid|not-paid "verification note"',
      );
    }
    path = "/api/reconcile";
    init = {
      method: "POST",
      body: JSON.stringify({ intentId, result, note }),
    };
  }
  const response = await requestApi(control, path, init);
  process.stdout.write(`${JSON.stringify(response.body, null, 2)}\n`);
  if (!response.response.ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command = "status", ...args] = process.argv.slice(2);
  if (command === "doctor") {
    await doctor();
    return;
  }
  if (command === "setup") {
    await setup();
    return;
  }
  if (!["status", "dry-run", "run", "arm", "disarm", "reconcile"].includes(command)) {
    throw new Error(
      "Commands: doctor, setup, status, dry-run, run --yes, arm, disarm, reconcile",
    );
  }
  await controlCommand(command, args);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown setup error.";
  process.stderr.write(`sce-pay: ${message}\n`);
  process.exitCode = 1;
});
