import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import { ScePayError } from "./errors.js";
import type { AppPaths } from "./paths.js";

const browserSchema = z.object({
  channel: z.enum(["chrome", "msedge", "chromium"]).default("chrome"),
  headless: z.boolean().default(true),
  navigationTimeoutMs: z.number().int().min(5_000).max(120_000).default(45_000),
});

const automationSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["observe", "pay"]).default("observe"),
  accountLabel: z.string().trim().min(1).nullable().default(null),
  paymentMethodLast4: z.string().regex(/^\d{4}$/).nullable().default(null),
  maxBillCents: z.number().int().positive().default(75_000),
  expectedFeeCents: z.number().int().nonnegative().default(165),
  payWhenDueWithinDays: z.number().int().min(0).max(60).default(21),
  requireDueDate: z.literal(true).default(true),
  authorizedAt: z.iso.datetime().nullable().default(null),
});

const notificationSchema = z.object({
  desktop: z.boolean().default(true),
});

const hostPatternSchema = z
  .string()
  .trim()
  .regex(
    /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i,
    "allowedHosts entries must be exact DNS hosts or safe subdomain wildcards",
  )
  .refine(
    (value) => !value.startsWith("*.") || value.slice(2).split(".").length >= 2,
    "wildcards may not target a public suffix",
  );

export const configSchema = z.object({
  version: z.literal(1),
  startUrl: z.url().refine((value) => new URL(value).protocol === "https:", {
    message: "startUrl must use HTTPS",
  }),
  allowedHosts: z.array(hostPatternSchema).min(1),
  browser: browserSchema,
  automation: automationSchema,
  notifications: notificationSchema,
});

export type AppConfig = z.infer<typeof configSchema>;

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    startUrl: "https://www.sce.com/mysce/billsnpayments/paybills",
    allowedHosts: [
      "sce.com",
      "*.sce.com",
      "chase.com",
      "*.chase.com",
      "jpmorgan.com",
      "*.jpmorgan.com",
      "jpmorganchase.com",
      "*.jpmorganchase.com",
    ],
    browser: {
      channel: "chrome",
      headless: true,
      navigationTimeoutMs: 45_000,
    },
    automation: {
      enabled: false,
      mode: "observe",
      accountLabel: null,
      paymentMethodLast4: null,
      maxBillCents: 75_000,
      expectedFeeCents: 165,
      payWhenDueWithinDays: 21,
      requireDueDate: true,
      authorizedAt: null,
    },
    notifications: {
      desktop: true,
    },
  };
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

export async function loadConfig(paths: AppPaths): Promise<AppConfig> {
  let raw: string;
  try {
    raw = await readFile(paths.configFile, "utf8");
  } catch (error) {
    throw new ScePayError(
      "CONFIG_INVALID",
      `No configuration found at ${paths.configFile}.`,
      {
        cause: error,
        remediation: "Run `sce-pay init` first.",
      },
    );
  }

  try {
    return configSchema.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new ScePayError("CONFIG_INVALID", "The configuration is invalid.", {
      cause: error,
      remediation: `Fix ${paths.configFile} or run \`sce-pay init --force\`.`,
    });
  }
}

export async function saveConfig(paths: AppPaths, config: AppConfig): Promise<void> {
  await writePrivateJson(paths.configFile, configSchema.parse(config));
}

export async function initializeConfig(
  paths: AppPaths,
  force: boolean,
): Promise<AppConfig> {
  if (!force) {
    try {
      await readFile(paths.configFile, "utf8");
      throw new ScePayError(
        "CONFIG_INVALID",
        `Configuration already exists at ${paths.configFile}.`,
        { remediation: "Use `sce-pay init --force` only if you intend to reset it." },
      );
    } catch (error) {
      if (error instanceof ScePayError) {
        throw error;
      }
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        throw error;
      }
    }
  }

  const config = defaultConfig();
  await saveConfig(paths, config);
  return config;
}
