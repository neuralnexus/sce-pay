import {
  type Browser,
  type BrowserContext,
  type Frame,
  type Locator,
  launch,
  type Page,
} from "@cloudflare/playwright";

import type {
  BillSnapshot,
  BrowserStateSnapshot,
  GuestBundle,
  PaymentConfirmation,
  PaymentReview,
  PortalClient,
} from "../domain.js";
import {
  PaymentUncertainError,
  PolicyStopError,
  ScePayError,
  SiteChangedError,
} from "../errors.js";
import { parseMoneyToCents } from "../money.js";
import {
  assertAllowedOrigin,
  assertAllowedTopLevelUrl,
  isLocallySafeRequestUrl,
  normalizedOrigin,
} from "../origins.js";
import {
  extractConfirmation,
  extractDisplayedCardLast4,
  extractDueDate,
  labeledMoney,
  safeAccountReference,
} from "../parsing.js";
import { validateReview } from "../policy.js";

type Scope = Page | Frame;

const BILL_LABELS = [
  "current amount due",
  "total amount due",
  "amount due",
  "balance due",
];
const FEE_LABELS = ["convenience fee", "service fee", "processing fee"];
const TOTAL_LABELS = ["total payment", "payment total", "total"];

async function firstVisible(locators: Locator[]): Promise<Locator | null> {
  for (const locator of locators) {
    const candidate = locator.first();
    if (
      (await candidate.count()) > 0 &&
      (await candidate.isVisible().catch(() => false))
    ) {
      return candidate;
    }
  }
  return null;
}

async function control(scopes: Scope[], name: RegExp): Promise<Locator | null> {
  for (const scope of scopes) {
    const found = await firstVisible([
      scope.getByRole("button", { name }),
      scope.getByRole("link", { name }),
      scope.getByRole("radio", { name }),
      scope.getByRole("tab", { name }),
      scope.getByText(name, { exact: true }),
    ]);
    if (found) return found;
  }
  return null;
}

async function input(scopes: Scope[], label: RegExp): Promise<Locator | null> {
  for (const scope of scopes) {
    const found = await firstVisible([
      scope.getByLabel(label),
      scope.getByPlaceholder(label),
    ]);
    if (found) return found;
  }
  return null;
}

async function allBodyText(page: Page): Promise<string> {
  const chunks = await Promise.all(
    page.frames().map((frame) =>
      frame
        .locator("body")
        .innerText({ timeout: 15_000 })
        .catch(() => ""),
    ),
  );
  return chunks.filter(Boolean).join("\n\n");
}

function scopes(page: Page): Scope[] {
  return [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
}

async function clickAndSettle(locator: Locator, page: Page): Promise<void> {
  await locator.click({ timeout: 15_000 });
  await page.waitForTimeout(750);
  await page
    .waitForLoadState("domcontentloaded", { timeout: 15_000 })
    .catch(() => undefined);
}

function detectInterruption(text: string): void {
  if (
    /verify (?:that )?you are human|complete (?:the )?captcha|captcha challenge|security check|challenge-platform/i.test(
      text,
    )
  ) {
    throw new ScePayError(
      "CAPTCHA_REQUIRED",
      "SCE requested an interactive anti-automation challenge.",
    );
  }
  if (
    /sign in to continue|log in to continue|session (?:has )?expired|forgot (?:your )?password/i.test(
      text,
    )
  ) {
    throw new ScePayError(
      "AUTHENTICATION_REQUIRED",
      "The guest flow unexpectedly requested an account login.",
    );
  }
  if (/temporarily unavailable|maintenance|try again later|access denied/i.test(text)) {
    throw new SiteChangedError("SCE did not make the guest payment form available.");
  }
}

export class CloudflareGuestPortal implements PortalClient {
  readonly #browserBinding: Fetcher;
  readonly #bundle: GuestBundle;
  #browser: Browser | undefined;
  #context: BrowserContext | undefined;
  #page: Page | undefined;
  #bill: BillSnapshot | undefined;
  #review: PaymentReview | undefined;
  #popupObserved = false;
  #environmentViolation: string | undefined;

  constructor(browserBinding: Fetcher, bundle: GuestBundle) {
    this.#browserBinding = browserBinding;
    this.#bundle = bundle;
  }

  async #open(): Promise<Page> {
    if (this.#page) return this.#page;
    this.#browser = await launch(this.#browserBinding);
    this.#context = await this.#browser.newContext({
      storageState: this.#bundle.storageState,
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    await this.#context.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      const origin = normalizedOrigin(requestUrl);
      if (
        isLocallySafeRequestUrl(requestUrl) ||
        (origin !== null && this.#bundle.allowedRequestOrigins.includes(origin))
      ) {
        await route.continue();
        return;
      }
      this.#environmentViolation =
        "The payment flow attempted an unreviewed network origin.";
      await route.abort("blockedbyclient");
    });
    await this.#context.routeWebSocket("**/*", (socket) => {
      const origin = normalizedOrigin(socket.url());
      if (origin && this.#bundle.allowedRequestOrigins.includes(origin)) {
        socket.connectToServer();
        return;
      }
      this.#environmentViolation =
        "The payment flow attempted an unreviewed WebSocket origin.";
      void socket.close({
        code: 1008,
        reason: "Origin was not approved during onboarding.",
      });
    });
    await this.#context.addInitScript((state) => {
      const values = state[location.origin];
      if (!values) return;
      for (const [key, value] of Object.entries(values)) {
        sessionStorage.setItem(key, value);
      }
    }, this.#bundle.sessionStorageByOrigin);
    const page = await this.#context.newPage();
    this.#context.on("page", (popup) => {
      if (popup === page) return;
      this.#popupObserved = true;
      void popup.close();
    });
    page.on("popup", (popup) => {
      this.#popupObserved = true;
      void popup.close();
    });
    page.on("download", (download) => {
      this.#environmentViolation = "The payment flow attempted an unexpected download.";
      void download.cancel();
    });
    page.on("dialog", (dialog) => {
      this.#environmentViolation =
        "The payment flow opened an unexpected browser dialog.";
      void dialog.dismiss();
    });
    page.on("websocket", (socket) => {
      const origin = normalizedOrigin(socket.url());
      if (origin === null || !this.#bundle.allowedRequestOrigins.includes(origin)) {
        this.#environmentViolation =
          "The payment flow attempted an unreviewed WebSocket origin.";
      }
    });
    page.on("framenavigated", (frame) => {
      try {
        if (frame === page.mainFrame()) {
          assertAllowedTopLevelUrl(frame.url());
          return;
        }
        const origin = normalizedOrigin(frame.url());
        if (
          origin &&
          !this.#bundle.allowedTopLevelOrigins.includes(origin) &&
          !this.#bundle.allowedFrameOrigins.includes(origin)
        ) {
          this.#environmentViolation =
            "The payment flow navigated a frame to an unreviewed origin.";
        }
      } catch {
        this.#environmentViolation =
          "Top-level navigation left the current SCE Guest Pay application.";
      }
    });
    await page.goto(this.#bundle.guestUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    this.#page = page;
    await this.#assertEnvironment();
    return page;
  }

  async #assertEnvironment(): Promise<void> {
    const page = this.#page;
    if (!page) throw new SiteChangedError("The SCE page was not opened.");
    if (this.#popupObserved) {
      throw new SiteChangedError(
        "The payment flow opened an unexpected top-level window.",
      );
    }
    if (this.#environmentViolation) {
      throw new SiteChangedError(this.#environmentViolation);
    }
    assertAllowedTopLevelUrl(page.url());
    assertAllowedOrigin(page.url(), this.#bundle.allowedTopLevelOrigins, "top-level");
    for (const frame of page.frames()) {
      const origin = normalizedOrigin(frame.url());
      if (
        origin &&
        !this.#bundle.allowedTopLevelOrigins.includes(origin) &&
        !this.#bundle.allowedFrameOrigins.includes(origin)
      ) {
        throw new SiteChangedError(
          "The payment form loaded an unreviewed external frame origin.",
        );
      }
    }
    detectInterruption(await allBodyText(page));
  }

  async #enterGuestAccount(page: Page): Promise<void> {
    const pageScopes = scopes(page);
    const guest = await control(
      pageScopes,
      /^(?:pay as guest|guest pay|guest user|pay without (?:signing|logging) in)$/i,
    );
    if (guest) {
      await clickAndSettle(guest, page);
      await this.#assertEnvironment();
    }

    const currentScopes = scopes(page);
    const account = await input(
      currentScopes,
      /(?:sce|customer|service)?\s*account\s*(?:number|no\.?|#)/i,
    );
    const zip = await input(
      currentScopes,
      /(?:5[- ]?digit\s+)?(?:mailing(?:\s+address)?\s+)?zip(?:\s+code)?/i,
    );
    if (account) await account.fill(this.#bundle.accountNumber);
    if (zip) await zip.fill(this.#bundle.mailingZip);
    if (account || zip) {
      if (!account || !zip) {
        throw new SiteChangedError(
          "Only part of the guest account form was recognized.",
        );
      }
      const next = await control(
        scopes(page),
        /^(?:continue|next|find account|submit)$/i,
      );
      if (!next)
        throw new SiteChangedError("The guest account form continue control changed.");
      await clickAndSettle(next, page);
      await this.#assertEnvironment();
    }
  }

  async inspectBill(): Promise<BillSnapshot | null> {
    const page = await this.#open();
    await this.#enterGuestAccount(page);
    const text = await allBodyText(page);
    detectInterruption(text);
    if (
      /no (?:current )?(?:balance|payment) due|amount due\s*:?\s*\$0\.00/i.test(text)
    ) {
      return null;
    }
    const bill: BillSnapshot = {
      accountReference: safeAccountReference(this.#bundle.accountNumber),
      amountCents: labeledMoney(text, BILL_LABELS),
      dueDate: extractDueDate(text),
      observedAt: new Date().toISOString(),
    };
    this.#bill = bill;
    return bill;
  }

  async preparePayment(bill: BillSnapshot): Promise<PaymentReview> {
    const page = await this.#open();
    if (!this.#bill || this.#bill.accountReference !== bill.accountReference) {
      throw new PolicyStopError("The bill was not inspected in this browser run.");
    }

    const fullBalance = await control(
      scopes(page),
      /^(?:current balance|full balance|amount due|pay total balance)$/i,
    );
    if (fullBalance) await fullBalance.click();

    const amountField = await input(
      scopes(page),
      /^(?:payment amount|amount to pay|other amount)$/i,
    );
    if (amountField) {
      await amountField.fill((bill.amountCents / 100).toFixed(2));
      const entered = parseMoneyToCents(await amountField.inputValue());
      if (entered !== bill.amountCents) {
        throw new PolicyStopError(
          "The guest form did not retain the full bill amount.",
        );
      }
    }

    const cardMode = await control(
      scopes(page),
      /(?:pay by card|credit (?:or|\/) debit card|debit (?:or|\/) credit card|card or digital wallet)/i,
    );
    if (cardMode) {
      await clickAndSettle(cardMode, page);
      await this.#assertEnvironment();
    }

    let text = await allBodyText(page);
    const cardPattern = new RegExp(
      `(?:ending(?:\\s+in)?|\\*{2,}|x{2,}|[•·]{2,})\\s*${this.#bundle.paymentMethodLast4}`,
      "i",
    );
    if (!cardPattern.test(text)) {
      throw new ScePayError(
        "CONFIGURATION_REQUIRED",
        "The tokenized guest session no longer exposes the reviewed payment method.",
      );
    }
    const savedMethod = await control(
      scopes(page),
      new RegExp(this.#bundle.paymentMethodLast4),
    );
    if (savedMethod) await savedMethod.click();

    for (let step = 0; step < 3; step += 1) {
      text = await allBodyText(page);
      if (
        FEE_LABELS.some((label) => new RegExp(label, "i").test(text)) &&
        TOTAL_LABELS.some((label) => new RegExp(label, "i").test(text))
      ) {
        break;
      }
      const next = await control(scopes(page), /^(?:continue|review|next)$/i);
      if (!next) break;
      await clickAndSettle(next, page);
      await this.#assertEnvironment();
    }

    text = await allBodyText(page);
    detectInterruption(text);
    const review: PaymentReview = {
      accountReference: bill.accountReference,
      amountCents: labeledMoney(text, ["payment amount", ...BILL_LABELS]),
      feeCents: labeledMoney(text, FEE_LABELS),
      totalCents: labeledMoney(text, TOTAL_LABELS),
      dueDate: bill.dueDate,
      observedAt: new Date().toISOString(),
      paymentMethodLast4: extractDisplayedCardLast4(text),
    };
    this.#review = review;
    return review;
  }

  async submitPayment(onWillSubmit: () => Promise<void>): Promise<PaymentConfirmation> {
    const page = this.#page;
    if (!page || !this.#review) {
      throw new PolicyStopError("A verified review is required before submission.");
    }
    await this.#assertEnvironment();

    const consent = await firstVisible(
      scopes(page).flatMap((scope) => [
        scope.getByRole("checkbox", { name: /agree|authorize|terms/i }),
      ]),
    );
    if (consent && !(await consent.isChecked())) await consent.check();
    await this.#assertEnvironment();

    const submitPattern =
      /^(?:submit payment|confirm payment|complete payment|pay now|make payment|pay\s+\$?[\d,.]+)$/i;
    const submitCandidates: Locator[] = [];
    for (const scope of scopes(page)) {
      for (const locator of [
        scope.getByRole("button", { name: submitPattern }),
        scope.getByRole("link", { name: submitPattern }),
      ]) {
        for (let index = 0; index < (await locator.count()); index += 1) {
          const candidate = locator.nth(index);
          if (await candidate.isVisible().catch(() => false)) {
            submitCandidates.push(candidate);
          }
        }
      }
    }
    if (submitCandidates.length !== 1) {
      throw new SiteChangedError(
        submitCandidates.length === 0
          ? "The final payment control was not found on the verified review."
          : "The verified review exposed more than one final payment control.",
      );
    }
    const submit = submitCandidates[0];
    if (!submit || !(await submit.isEnabled())) {
      throw new SiteChangedError("The final payment control is not enabled.");
    }

    const finalText = await allBodyText(page);
    const finalAmount = labeledMoney(finalText, ["payment amount", ...BILL_LABELS]);
    const finalFee = labeledMoney(finalText, FEE_LABELS);
    const finalTotal = labeledMoney(finalText, TOTAL_LABELS);
    const finalLast4 = extractDisplayedCardLast4(finalText);
    const finalReview: PaymentReview = {
      ...this.#review,
      amountCents: finalAmount,
      feeCents: finalFee,
      totalCents: finalTotal,
      paymentMethodLast4: finalLast4,
      observedAt: new Date().toISOString(),
    };
    try {
      validateReview(this.#bill ?? finalReview, finalReview, this.#bundle, new Date());
    } catch {
      throw new PolicyStopError(
        "The payment review changed immediately before submission.",
      );
    }
    if (
      finalAmount !== this.#review.amountCents ||
      finalFee !== this.#review.feeCents ||
      finalTotal !== this.#review.totalCents ||
      finalLast4 !== this.#review.paymentMethodLast4
    ) {
      throw new PolicyStopError(
        "The payment review changed immediately before submission.",
      );
    }

    await onWillSubmit();
    try {
      await submit.click({ timeout: 15_000 });
      await page.waitForTimeout(1_000);
      await page
        .waitForLoadState("domcontentloaded", { timeout: 15_000 })
        .catch(() => undefined);
      await this.#assertEnvironment();
      const text = await allBodyText(page);
      if (
        !/thank you|payment (?:was )?(?:submitted|successful|received|confirmed)/i.test(
          text,
        )
      ) {
        throw new PaymentUncertainError();
      }
      return {
        confirmationNumber: extractConfirmation(text),
        paidAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof PaymentUncertainError) throw error;
      throw new PaymentUncertainError();
    }
  }

  async captureBrowserState(): Promise<BrowserStateSnapshot> {
    const context = this.#context;
    const page = this.#page;
    if (!context || !page) {
      throw new SiteChangedError("No browser state is available to refresh.");
    }
    await this.#assertEnvironment();
    const sessionStorageByOrigin: Record<string, Record<string, string>> = {};
    for (const frame of page.frames()) {
      const origin = normalizedOrigin(frame.url());
      if (!origin) continue;
      const values = await frame
        .evaluate(() => Object.fromEntries(Object.entries(sessionStorage)))
        .catch(() => undefined);
      if (values && Object.keys(values).length > 0) {
        sessionStorageByOrigin[origin] = values;
      }
    }
    return {
      storageState: await context.storageState({ indexedDB: true }),
      sessionStorageByOrigin,
    };
  }

  async close(): Promise<void> {
    await this.#browser?.close();
    this.#browser = undefined;
    this.#context = undefined;
    this.#page = undefined;
  }
}

export const guestPortalInternals = {
  detectInterruption,
};
