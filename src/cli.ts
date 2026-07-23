#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { Command, Option } from "commander";

import { AuditLog } from "./audit.js";
import {
  initializeConfig,
  loadConfig,
  saveConfig,
  type AppConfig,
} from "./config.js";
import { systemClock } from "./domain.js";
import { ScePayError } from "./errors.js";
import { acquireRunLock } from "./lock.js";
import { formatCents, parseMoneyToCents } from "./money.js";
import { notifyDesktop } from "./notifications.js";
import { resolveAppPaths } from "./paths.js";
import {
  openInteractiveSceSession,
  PlaywrightScePortal,
} from "./portal/playwrightPortal.js";
import {
  installSchedule,
  removeSchedule,
  scheduleArtifacts,
} from "./scheduler.js";
import { StateStore } from "./state.js";
import { runPaymentWorkflow } from "./workflow.js";

const paths = resolveAppPaths();

function print(value: string): void {
  stdout.write(`${value}\n`);
}

async function confirmArm(nonInteractive: boolean): Promise<void> {
  if (nonInteractive) {
    return;
  }
  if (!stdin.isTTY) {
    throw new ScePayError(
      "CONFIG_INVALID",
      "Arming requires an interactive confirmation or --yes.",
    );
  }

  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    print(
      "This authorizes sce-pay to submit the full SCE balance and accepted fee automatically within your configured limit.",
    );
    const answer = await prompt.question('Type "ARM" to continue: ');
    if (answer !== "ARM") {
      throw new ScePayError("CONFIG_INVALID", "Payment automation was not armed.");
    }
  } finally {
    prompt.close();
  }
}

function updateAuthorization(
  config: AppConfig,
  options: {
    last4: string;
    max: string;
    fee: string;
    account?: string;
  },
): AppConfig {
  const maxBillCents = parseMoneyToCents(options.max);
  const expectedFeeCents = parseMoneyToCents(options.fee);
  return {
    ...config,
    automation: {
      ...config.automation,
      enabled: true,
      mode: "pay",
      paymentMethodLast4: options.last4,
      maxBillCents,
      expectedFeeCents,
      accountLabel: options.account ?? config.automation.accountLabel,
      authorizedAt: new Date().toISOString(),
    },
  };
}

async function executeRun(options: {
  dryRun: boolean;
  headed: boolean;
}): Promise<void> {
  const release = await acquireRunLock(paths.lockFile);
  let config: AppConfig | null = null;
  try {
    config = await loadConfig(paths);
    const portal = new PlaywrightScePortal({
      config,
      paths,
      headed: options.headed,
    });
    const outcome = await runPaymentWorkflow(
      {
        config,
        portal,
        state: new StateStore(paths),
        audit: new AuditLog(paths),
        clock: systemClock,
      },
      { dryRun: options.dryRun },
    );
    print(outcome.message);
    if (config.notifications.desktop && outcome.status === "paid") {
      await notifyDesktop("SCE bill paid", outcome.message);
    }
  } catch (error) {
    if (config?.notifications.desktop === true) {
      const message =
        error instanceof Error ? error.message : "The SCE payment check failed.";
      await notifyDesktop("SCE Pay needs attention", message);
    }
    throw error;
  } finally {
    await release();
  }
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("sce-pay")
    .description(
      "Safely automate the full current SCE bill using a card saved directly with SCE/Chase.",
    )
    .version("0.1.0");

  program
    .command("init")
    .description("Create a disabled, observe-only configuration.")
    .option("--force", "replace the current configuration", false)
    .action(async (options: { force: boolean }) => {
      await initializeConfig(paths, options.force);
      print(`Created ${paths.configFile}`);
      print("Next: run `sce-pay login`, then `sce-pay arm`.");
    });

  program
    .command("login")
    .description("Open the private browser profile for manual SCE login/card setup.")
    .action(async () => {
      const config = await loadConfig(paths);
      print(
        "Complete SCE sign-in and save/select your card directly in the SCE/Chase pages.",
      );
      print("sce-pay never asks for or fills card numbers, passwords, MFA, or CAPTCHA.");
      const context = await openInteractiveSceSession({ config, paths });
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        await prompt.question("Press Enter here after setup is complete...");
      } finally {
        prompt.close();
        await context.close();
      }
    });

  program
    .command("arm")
    .description("Authorize automatic submission within explicit card/amount/fee limits.")
    .requiredOption("--last4 <digits>", "last four digits of the saved card")
    .requiredOption("--max <dollars>", "maximum SCE bill amount, such as 750.00")
    .option("--fee <dollars>", "exact accepted convenience fee", "1.65")
    .option("--account <label>", "visible label that identifies the intended account")
    .option("--yes", "accept authorization non-interactively", false)
    .action(
      async (options: {
        last4: string;
        max: string;
        fee: string;
        account?: string;
        yes: boolean;
      }) => {
        if (!/^\d{4}$/.test(options.last4)) {
          throw new ScePayError(
            "CONFIG_INVALID",
            "--last4 must contain exactly four digits.",
          );
        }
        await confirmArm(options.yes);
        const config = updateAuthorization(await loadConfig(paths), options);
        await saveConfig(paths, config);
        print(
          `Armed for card ending ${options.last4}: bill limit ${formatCents(config.automation.maxBillCents)}, exact fee ${formatCents(config.automation.expectedFeeCents)}.`,
        );
        print("Run `sce-pay run --dry-run --headed` before installing the schedule.");
      },
    );

  program
    .command("disarm")
    .description("Disable payment submission without deleting the browser profile.")
    .action(async () => {
      const config = await loadConfig(paths);
      await saveConfig(paths, {
        ...config,
        automation: {
          ...config.automation,
          enabled: false,
          mode: "observe",
          authorizedAt: null,
        },
      });
      print("Payment submission is disabled.");
    });

  program
    .command("run")
    .description("Inspect the bill and, when armed, safely pay it.")
    .option("--dry-run", "prepare and validate the review without submitting", false)
    .option("--headed", "show the browser window", false)
    .action(executeRun);

  program
    .command("status")
    .description("Show configuration and recent run/payment state without opening SCE.")
    .action(async () => {
      const config = await loadConfig(paths);
      const state = await new StateStore(paths).snapshot();
      const latestRun = state.runs.at(-1);
      const unresolved = state.paymentIntents.filter(
        (intent) => intent.status === "submitting" || intent.status === "unknown",
      );
      print(`Mode: ${config.automation.enabled ? config.automation.mode : "disabled"}`);
      print(`Bill limit: ${formatCents(config.automation.maxBillCents)}`);
      print(`Accepted fee: ${formatCents(config.automation.expectedFeeCents)}`);
      print(`Payment window: ${config.automation.payWhenDueWithinDays} days before due`);
      print(
        latestRun === undefined
          ? "Last run: never"
          : `Last run: ${latestRun.status} at ${latestRun.startedAt} — ${latestRun.message ?? ""}`,
      );
      print(`Unresolved payment intents: ${unresolved.length}`);
      for (const intent of unresolved) {
        print(
          `  ${intent.id} ${intent.status} ${formatCents(intent.totalCents)} created ${intent.createdAt}`,
        );
      }
    });

  program
    .command("reconcile <intent-id>")
    .description("Resolve an ambiguous intent after checking SCE payment history.")
    .addOption(
      new Option("--as <result>", "verified result")
        .choices(["paid", "not-paid"])
        .makeOptionMandatory(),
    )
    .requiredOption("--note <text>", "how the result was verified")
    .option("--confirmation <number>", "SCE/Chase confirmation number")
    .action(
      async (
        intentId: string,
        options: {
          as: "paid" | "not-paid";
          note: string;
          confirmation?: string;
        },
      ) => {
        const intent = await new StateStore(paths).reconcileIntent(
          intentId,
          options.as,
          options.note,
          new Date().toISOString(),
          options.confirmation,
        );
        print(`Intent ${intent.id} is now ${intent.status}.`);
      },
    );

  const schedule = program
    .command("schedule")
    .description("Manage the local daily 9:00 a.m. scheduler.");
  schedule
    .command("print")
    .description("Print the scheduler definition without installing it.")
    .action(() => {
      for (const artifact of scheduleArtifacts(
        process.platform,
        paths,
        process.execPath,
        process.argv[1] ?? "",
      )) {
        print(`# ${artifact.path}\n${artifact.content}`);
      }
    });
  schedule
    .command("install")
    .description("Install and start the user-level scheduler.")
    .action(async () => {
      const config = await loadConfig(paths);
      if (!config.automation.enabled || config.automation.mode !== "pay") {
        throw new ScePayError(
          "CONFIG_INVALID",
          "Run a successful dry run and arm payment mode before scheduling.",
        );
      }
      const state = await new StateStore(paths).snapshot();
      const authorizedAt = config.automation.authorizedAt;
      const successfulDryRun = state.runs
        .toReversed()
        .find(
          (run) =>
            run.dryRun &&
            run.status === "succeeded" &&
            authorizedAt !== null &&
            run.startedAt >= authorizedAt,
        );
      if (successfulDryRun === undefined) {
        throw new ScePayError(
          "CONFIG_INVALID",
          "A successful dry run is required before scheduler installation.",
          { remediation: "Run `sce-pay run --dry-run --headed` first." },
        );
      }
      const artifacts = await installSchedule(
        process.platform,
        paths,
        process.execPath,
        process.argv[1] ?? "",
      );
      print(`Installed daily schedule at ${artifacts.map(({ path }) => path).join(", ")}`);
    });
  schedule
    .command("remove")
    .description("Stop and remove the user-level scheduler.")
    .action(async () => {
      const artifacts = await removeSchedule(
        process.platform,
        paths,
        process.execPath,
        process.argv[1] ?? "",
      );
      print(`Removed ${artifacts.map(({ path }) => path).join(", ")}`);
    });

  return program;
}

async function main(): Promise<void> {
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (error) {
    if (error instanceof ScePayError) {
      process.stderr.write(`[${error.code}] ${error.message}\n`);
      if (error.remediation !== undefined) {
        process.stderr.write(`${error.remediation}\n`);
      }
    } else {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Unknown error"}\n`,
      );
    }
    process.exitCode = 1;
  }
}

await main();
