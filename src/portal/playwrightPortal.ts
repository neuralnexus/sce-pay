import { createHash } from "node:crypto";

import {
  chromium,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from "playwright";

import type { AppConfig } from "../config.js";
import type {
  BillSnapshot,
  PaymentConfirmation,
  PaymentReview,
  PortalClient,
} from "../domain.js";
import {
  AuthenticationRequiredError,
  CaptchaRequiredError,
  PaymentSubmissionUncertainError,
  SafetyStopError,
  SiteChangedError,
} from "../errors.js";
import { parseMoneyToCents } from "../money.js";
import type { AppPaths } from "../paths.js";

const CARD_DATA_SELECTOR = [
  'input[autocomplete="cc-number"]',
  'input[name*="cardNumber" i]',
  'input[id*="cardNumber" i]',
  'iframe[title*="card number" i]',
].join(",");

const CAPTCHA_SELECTOR = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  '[class*="captcha" i]',
  '[id*="captcha" i]',
].join(",");

const AMOUNT_LABELS = [
  "total amount due",
  "current amount due",
  "amount due",
  "current balance",
  "payment amount",
];

const FEE_LABELS = ["convenience fee", "processing fee", "service fee"];
const TOTAL_LABELS = ["total payment", "payment total", "total charge", "total"];

type PortalDependencies = {
  config: AppConfig;
  paths: AppPaths;
  headed?: boolean;
};

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hostMatches(host: string, pattern: string): boolean {
  const normalizedHost = host.toLowerCase().replace(/\.$/, "");
  const normalizedPattern = pattern.toLowerCase().replace(/\.$/, "");
  if (!normalizedPattern.startsWith("*.")) {
    return normalizedHost === normalizedPattern;
  }

  const suffix = normalizedPattern.slice(1);
  return (
    normalizedHost.endsWith(suffix) &&
    normalizedHost.length > suffix.length &&
    normalizedHost.at(-(suffix.length + 1)) !== "."
  );
}

function assertAllowedUrl(url: string, allowedHosts: string[]): void {
  if (url === "about:blank") {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SafetyStopError(`The browser reached an invalid URL: ${url}`);
  }

  if (
    parsed.protocol !== "https:" ||
    (parsed.port !== "" && parsed.port !== "443") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !allowedHosts.some((pattern) => hostMatches(parsed.hostname, pattern))
  ) {
    throw new SafetyStopError(
      `Stopped at unapproved payment host "${parsed.hostname}".`,
      "Verify the host belongs to SCE or JP Morgan Chase, then add only that exact host to allowedHosts.",
    );
  }
}

async function firstVisible(locators: Locator[]): Promise<Locator | null> {
  for (const locator of locators) {
    const candidate = locator.first();
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }
  return null;
}

async function bodyTexts(page: Page): Promise<string[]> {
  const texts: string[] = [];
  for (const frame of page.frames()) {
    const text = await frame
      .locator("body")
      .innerText({ timeout: 2_000 })
      .catch(() => "");
    if (text.trim() !== "") {
      texts.push(text);
    }
  }
  return texts;
}

async function combinedBodyText(page: Page): Promise<string> {
  return (await bodyTexts(page)).join("\n");
}

function labeledMoney(text: string, labels: string[]): number | null {
  for (const label of labels) {
    const escaped = escapeRegExp(label);
    const forward = new RegExp(
      `${escaped}\\s*(?:\\([^)]*\\))?\\s*:?\\s*\\$\\s*([\\d,]+(?:\\.\\d{2})?)`,
      "i",
    ).exec(text);
    if (forward !== null) {
      return parseMoneyToCents(forward[1] ?? "");
    }

    const line = text
      .split("\n")
      .find((candidate) => candidate.toLowerCase().includes(label));
    if (line !== undefined && /\$\s*[\d,]+(?:\.\d{2})?/.test(line)) {
      return parseMoneyToCents(line);
    }
  }
  return null;
}

function isoDate(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, " ");
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (isoMatch !== null) {
    return normalized;
  }

  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(normalized);
  if (slashMatch !== null) {
    const month = Number.parseInt(slashMatch[1] ?? "", 10);
    const day = Number.parseInt(slashMatch[2] ?? "", 10);
    const year = Number.parseInt(slashMatch[3] ?? "", 10);
    return `${year.toString().padStart(4, "0")}-${month
      .toString()
      .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
  }

  const namedMatch = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(normalized);
  if (namedMatch !== null) {
    const months: Record<string, number> = {
      jan: 1,
      feb: 2,
      mar: 3,
      apr: 4,
      may: 5,
      jun: 6,
      jul: 7,
      aug: 8,
      sep: 9,
      oct: 10,
      nov: 11,
      dec: 12,
    };
    const month = months[(namedMatch[1] ?? "").slice(0, 3).toLowerCase()];
    if (month === undefined) {
      return null;
    }
    const day = Number.parseInt(namedMatch[2] ?? "", 10);
    const year = Number.parseInt(namedMatch[3] ?? "", 10);
    return `${year.toString().padStart(4, "0")}-${month
      .toString()
      .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
  }

  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) {
    return null;
  }
  const date = new Date(parsed);
  return [
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
}

function extractDueDate(text: string): string | null {
  const patterns = [
    /(?:payment\s+)?due\s+date\s*:?\s*([A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4})/i,
    /(?:payment\s+)?due\s+date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /(?:payment\s+)?due\s+date\s*:?\s*(\d{4}-\d{2}-\d{2})/i,
    /(?:amount\s+)?due\s+(?:on|by)\s+([A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4})/i,
    /(?:amount\s+)?due\s+(?:on|by)\s+(\d{1,2}\/\d{1,2}\/\d{4})/i,
  ];
  for (const pattern of patterns) {
    const candidate = pattern.exec(text)?.[1];
    if (candidate !== undefined) {
      return isoDate(candidate);
    }
  }
  return null;
}

function safeAccountReference(text: string, configuredLabel: string | null): string {
  let source = configuredLabel;
  if (source !== null && !text.toLowerCase().includes(source.toLowerCase())) {
    throw new SafetyStopError(
      `Configured account label "${source}" was not visible on the payment page.`,
      "Open `sce-pay login`, confirm the desired account, and update automation.accountLabel.",
    );
  }

  source ??=
    /(?:service\s+)?account(?:\s+(?:number|no\.?))?\s*:?\s*([*xX•\d-]{4,})/i.exec(
      text,
    )?.[1] ?? "primary-sce-account";

  return `sce-${createHash("sha256").update(source).digest("hex").slice(0, 12)}`;
}

async function detectInterruption(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    if (
      await frame
        .locator(CAPTCHA_SELECTOR)
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      throw new CaptchaRequiredError();
    }
  }

  const text = await combinedBodyText(page);
  if (/verify (?:that )?you are (?:a )?human|security challenge/i.test(text)) {
    throw new CaptchaRequiredError();
  }
  if (
    /maintenance in progress|currently undergoing maintenance|service (?:is )?unavailable|temporarily unavailable/i.test(
      text,
    )
  ) {
    throw new SiteChangedError(
      "SCE or its payment processor is temporarily unavailable.",
      "The scheduler will try again on its next run.",
    );
  }

  let passwordVisible = false;
  for (const frame of page.frames()) {
    passwordVisible ||= await frame
      .locator('input[type="password"]')
      .first()
      .isVisible()
      .catch(() => false);
  }
  if (passwordVisible) {
    throw new AuthenticationRequiredError();
  }
}

async function waitForApplication(page: Page, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let latestText = "";
  while (Date.now() < deadline) {
    await detectInterruption(page);
    latestText = await combinedBodyText(page);
    if (
      latestText.trim() !== "" &&
      !/we(?:'|’)re working on your request[\s\S]*please stand by/i.test(latestText)
    ) {
      return latestText;
    }
    await page.waitForTimeout(500);
  }
  return latestText;
}

async function namedControl(
  page: Page,
  names: RegExp,
  frames: Frame[] = page.frames(),
): Promise<Locator | null> {
  for (const frame of frames) {
    const result = await firstVisible([
      frame.getByRole("button", { name: names }),
      frame.getByRole("link", { name: names }),
      frame.locator('input[type="submit"]').filter({ hasText: names }),
    ]);
    if (result !== null) {
      return result;
    }
  }
  return null;
}

async function transitionAfterClick(
  context: BrowserContext,
  page: Page,
  control: Locator,
): Promise<Page> {
  const existingPages = new Set(context.pages());
  const popup = page.waitForEvent("popup", { timeout: 7_000 }).catch(() => null);
  await control.click();
  const opened = await popup;
  const target =
    opened ??
    context.pages().find((candidate) => !existingPages.has(candidate)) ??
    page;
  await target.waitForLoadState("domcontentloaded").catch(() => undefined);
  return target;
}

async function launchContext(
  dependencies: PortalDependencies,
  forceHeaded = false,
): Promise<BrowserContext> {
  const { config, paths } = dependencies;
  const channel =
    config.browser.channel === "chromium" ? undefined : config.browser.channel;
  return chromium.launchPersistentContext(paths.profileDir, {
    headless: forceHeaded ? false : !dependencies.headed && config.browser.headless,
    ...(channel === undefined ? {} : { channel }),
    acceptDownloads: false,
    locale: "en-US",
    viewport: { width: 1440, height: 1000 },
  });
}

export class PlaywrightScePortal implements PortalClient {
  readonly #dependencies: PortalDependencies;
  #context: BrowserContext | null = null;
  #page: Page | null = null;
  #bill: BillSnapshot | null = null;
  #review: PaymentReview | null = null;

  constructor(dependencies: PortalDependencies) {
    this.#dependencies = dependencies;
  }

  async inspectBill(): Promise<BillSnapshot | null> {
    const { config } = this.#dependencies;
    this.#context = await launchContext(this.#dependencies);
    this.#context.setDefaultTimeout(config.browser.navigationTimeoutMs);
    this.#context.setDefaultNavigationTimeout(config.browser.navigationTimeoutMs);

    const page = this.#context.pages()[0] ?? (await this.#context.newPage());
    this.#page = page;
    await page.goto(config.startUrl, { waitUntil: "domcontentloaded" });
    assertAllowedUrl(page.url(), config.allowedHosts);
    const initialText = await waitForApplication(
      page,
      config.browser.navigationTimeoutMs,
    );

    if (/no (?:payment|balance) (?:is )?due|amount due\s*:?\s*\$0\.00/i.test(initialText)) {
      return null;
    }

    let amountCents = labeledMoney(initialText, AMOUNT_LABELS);
    let dueDate = extractDueDate(initialText);
    let accountReference = safeAccountReference(
      initialText,
      config.automation.accountLabel,
    );

    const paymentEntry = await namedControl(
      page,
      /pay by card|card or digital wallet/i,
    );
    if (paymentEntry !== null) {
      this.#page = await transitionAfterClick(this.#context, page, paymentEntry);
    } else {
      const makePayment = await namedControl(page, /make a payment/i);
      if (makePayment !== null) {
        this.#page = await transitionAfterClick(this.#context, page, makePayment);
        const cardEntry = await namedControl(
          this.#page,
          /pay by card|card or digital wallet/i,
        );
        if (cardEntry === null) {
          throw new SiteChangedError(
            'Could not find SCE\'s documented "Pay by Card" control.',
          );
        }
        this.#page = await transitionAfterClick(
          this.#context,
          this.#page,
          cardEntry,
        );
      }
    }

    assertAllowedUrl(this.#page.url(), config.allowedHosts);
    let paymentText = await waitForApplication(
      this.#page,
      config.browser.navigationTimeoutMs,
    );
    const payBill = await namedControl(this.#page, /^pay bill$/i);
    if (payBill !== null) {
      this.#page = await transitionAfterClick(this.#context, this.#page, payBill);
      assertAllowedUrl(this.#page.url(), config.allowedHosts);
      paymentText = await waitForApplication(
        this.#page,
        config.browser.navigationTimeoutMs,
      );
    }

    if (
      /no (?:payment|balance) (?:is )?due|amount due\s*:?\s*\$0\.00/i.test(
        paymentText,
      )
    ) {
      return null;
    }

    amountCents ??= labeledMoney(paymentText, AMOUNT_LABELS);
    dueDate ??= extractDueDate(paymentText);
    accountReference = safeAccountReference(
      `${initialText}\n${paymentText}`,
      config.automation.accountLabel,
    );

    if (amountCents === null) {
      throw new SiteChangedError(
        "Could not identify the current amount due on SCE's payment pages.",
      );
    }
    if (dueDate === null) {
      throw new SiteChangedError(
        "Could not identify the bill due date. Automatic payment requires a bill-cycle key.",
      );
    }

    this.#bill = {
      accountReference,
      amountCents,
      dueDate,
      observedAt: new Date().toISOString(),
    };
    return this.#bill;
  }

  async preparePayment(
    bill: BillSnapshot,
    paymentMethodLast4: string,
  ): Promise<PaymentReview> {
    const page = this.#requirePage();
    const { config } = this.#dependencies;
    if (this.#bill === null || this.#bill !== bill) {
      throw new SafetyStopError("Payment preparation did not use the inspected bill.");
    }

    await detectInterruption(page);
    let text = await combinedBodyText(page);
    const cardPattern = new RegExp(
      `(?:ending\\s+(?:in\\s+)?)?(?:[xX*•-]*\\s*)${escapeRegExp(paymentMethodLast4)}\\b`,
      "i",
    );

    let savedMethod: Locator | null = null;
    for (const frame of page.frames()) {
      savedMethod = await firstVisible([
        frame.locator("label").filter({ hasText: cardPattern }),
        frame.getByRole("radio", { name: cardPattern }),
        frame.getByText(cardPattern),
      ]);
      if (savedMethod !== null) {
        break;
      }
    }
    if (savedMethod === null) {
      let cardFieldsVisible = false;
      for (const frame of page.frames()) {
        cardFieldsVisible ||= await frame
          .locator(CARD_DATA_SELECTOR)
          .first()
          .isVisible()
          .catch(() => false);
      }
      throw new AuthenticationRequiredError(
        cardFieldsVisible
          ? `Saved card ending ${paymentMethodLast4} is unavailable; sce-pay will not enter raw card data.`
          : `Could not find the authorized saved card ending ${paymentMethodLast4}.`,
      );
    }
    await savedMethod.click().catch(() => undefined);

    let amountInput: Locator | null = null;
    for (const frame of page.frames()) {
      amountInput = await firstVisible([
        frame.getByLabel(/payment amount/i),
        frame.locator('input[name*="amount" i]'),
      ]);
      if (amountInput !== null) {
        break;
      }
    }
    if (amountInput !== null) {
      const inputAmount = parseMoneyToCents(await amountInput.inputValue());
      if (inputAmount !== bill.amountCents) {
        throw new SafetyStopError(
          "The payment processor did not default to the full current amount due.",
        );
      }
    } else {
      const displayedAmount = labeledMoney(text, AMOUNT_LABELS);
      if (displayedAmount !== null && displayedAmount !== bill.amountCents) {
        throw new SafetyStopError(
          "The displayed payment amount differs from SCE's current amount due.",
        );
      }
    }

    const continueControl = await namedControl(
      page,
      /^(?:continue|review payment|next)$/i,
    );
    if (continueControl === null) {
      throw new SiteChangedError(
        "Could not find the documented control for reviewing the card payment.",
      );
    }

    this.#page = await transitionAfterClick(
      this.#requireContext(),
      page,
      continueControl,
    );
    assertAllowedUrl(this.#page.url(), config.allowedHosts);
    text = await waitForApplication(
      this.#page,
      config.browser.navigationTimeoutMs,
    );
    await detectInterruption(this.#page);

    if (!cardPattern.test(text)) {
      throw new SafetyStopError(
        `The review page does not show card ending ${paymentMethodLast4}.`,
      );
    }

    const amountCents = labeledMoney(text, ["payment amount", ...AMOUNT_LABELS]);
    const feeCents = labeledMoney(text, FEE_LABELS);
    const totalCents = labeledMoney(text, TOTAL_LABELS);
    if (amountCents === null || feeCents === null || totalCents === null) {
      throw new SiteChangedError(
        "Could not read the payment amount, convenience fee, and total from the review page.",
      );
    }

    this.#review = {
      accountReference: bill.accountReference,
      amountCents,
      feeCents,
      totalCents,
      dueDate: bill.dueDate,
      paymentMethodLast4,
    };
    return this.#review;
  }

  async submitPayment(
    onWillSubmit: () => Promise<void>,
  ): Promise<PaymentConfirmation> {
    const page = this.#requirePage();
    if (this.#review === null) {
      throw new SafetyStopError("A validated payment review is required before submission.");
    }

    await detectInterruption(page);
    const submit = await namedControl(
      page,
      /^(?:submit payment|confirm payment|complete payment|pay now|pay \$?[\d,.]+)$/i,
    );
    if (submit === null) {
      throw new SiteChangedError(
        "Could not find an unambiguous final payment submission control.",
      );
    }

    await onWillSubmit();
    try {
      this.#page = await transitionAfterClick(
        this.#requireContext(),
        page,
        submit,
      );
      assertAllowedUrl(
        this.#page.url(),
        this.#dependencies.config.allowedHosts,
      );
      const text = await waitForApplication(
        this.#page,
        this.#dependencies.config.browser.navigationTimeoutMs,
      );
      if (
        !/payment (?:has been )?(?:received|submitted|successful|complete)|thank you/i.test(
          text,
        )
      ) {
        throw new PaymentSubmissionUncertainError(
          "The final page did not contain a recognizable payment-success message.",
        );
      }

      const confirmationNumber =
        /confirmation(?:\s+(?:number|no\.?))?\s*[:#]?\s*([A-Z0-9-]{4,})/i.exec(
          text,
        )?.[1];
      if (confirmationNumber === undefined) {
        throw new PaymentSubmissionUncertainError(
          "Payment success was displayed without a recognizable confirmation number.",
        );
      }

      return {
        confirmationNumber,
        paidAt: new Date().toISOString(),
      };
    } catch (error) {
      throw error instanceof PaymentSubmissionUncertainError
        ? error
        : new PaymentSubmissionUncertainError(
            "The final payment control was activated, but the result is unknown.",
            error,
          );
    }
  }

  async close(): Promise<void> {
    await this.#context?.close();
    this.#context = null;
    this.#page = null;
  }

  #requireContext(): BrowserContext {
    if (this.#context === null) {
      throw new Error("Browser context is not open.");
    }
    return this.#context;
  }

  #requirePage(): Page {
    if (this.#page === null) {
      throw new Error("Payment page is not open.");
    }
    return this.#page;
  }
}

export async function openInteractiveSceSession(
  dependencies: Omit<PortalDependencies, "headed">,
): Promise<BrowserContext> {
  const context = await launchContext({ ...dependencies, headed: true }, true);
  context.setDefaultTimeout(dependencies.config.browser.navigationTimeoutMs);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(dependencies.config.startUrl, { waitUntil: "domcontentloaded" });
  return context;
}

export const portalInternals = {
  assertAllowedUrl,
  extractDueDate,
  hostMatches,
  isoDate,
  labeledMoney,
  safeAccountReference,
};
