import type { BrowserContextOptions } from "@cloudflare/playwright";

export interface BrowserStateSnapshot {
  storageState: NonNullable<BrowserContextOptions["storageState"]>;
  sessionStorageByOrigin: Record<string, Record<string, string>>;
}

export interface GuestBundle {
  version: 2;
  configurationId: string;
  capturedAt: string;
  guestUrl: string;
  accountNumber: string;
  mailingZip: string;
  paymentMethodLast4: string;
  maxBillCents: number;
  feeLimitCentsExclusive: number;
  payWhenDueWithinDays: number;
  allowedTopLevelOrigins: string[];
  allowedFrameOrigins: string[];
  allowedRequestOrigins: string[];
  storageState: BrowserStateSnapshot["storageState"];
  sessionStorageByOrigin: BrowserStateSnapshot["sessionStorageByOrigin"];
  notificationWebhookUrl?: string;
  notificationWebhookSecret?: string;
}

export interface EncryptedBundle {
  version: 2;
  algorithm: "AES-256-GCM";
  bundleId: string;
  createdAt: string;
  iv: string;
  ciphertext: string;
}

export interface BillSnapshot {
  accountReference: string;
  amountCents: number;
  dueDate: string;
  observedAt: string;
}

export interface PaymentReview extends BillSnapshot {
  feeCents: number;
  totalCents: number;
  paymentMethodLast4: string;
}

export interface PaymentConfirmation {
  confirmationNumber: string;
  paidAt: string;
}

export type IntentStatus =
  | "submitting"
  | "unknown"
  | "confirmed"
  | "reconciled-not-paid";

export interface PaymentIntent {
  id: string;
  fingerprint: string;
  status: IntentStatus;
  amountCents: number;
  feeCents: number;
  totalCents: number;
  dueDate: string;
  createdAt: string;
  updatedAt: string;
  confirmationNumber?: string;
  reconciliationNote?: string;
}

export interface RunLease {
  id: string;
  expiresAt: string;
}

export interface PublicStatus {
  configured: boolean;
  armed: boolean;
  releaseId: string;
  configurationId?: string;
  configuredAt?: string;
  armedAt?: string;
  dryRunValidatedAt?: string;
  nextCheckAt?: string;
  armBlockReason?: string;
  activeRun: boolean;
  blockingIntent?: PaymentIntent;
  lastRun?: RunRecord;
  confirmedPayments: PaymentIntent[];
  recentRuns: RunRecord[];
}

export interface RunRecord {
  id: string;
  at: string;
  source: "cron" | "manual";
  dryRun: boolean;
  outcome: string;
  message: string;
  releaseId: string;
}

export type WorkflowOutcome =
  | { status: "deferred"; message: string; nextCheckAt: string }
  | { status: "no-balance"; message: string }
  | { status: "not-due"; message: string; dueDate: string }
  | { status: "already-paid"; message: string }
  | { status: "dry-run"; message: string; review: PaymentReview }
  | {
      status: "paid";
      message: string;
      review: PaymentReview;
      confirmation: PaymentConfirmation;
    };

export interface WorkflowExecution {
  outcome: Exclude<WorkflowOutcome, { status: "deferred" }>;
  refreshedBrowserState?: BrowserStateSnapshot;
}

export interface PortalClient {
  inspectBill(): Promise<BillSnapshot | null>;
  preparePayment(bill: BillSnapshot): Promise<PaymentReview>;
  submitPayment(onWillSubmit: () => Promise<void>): Promise<PaymentConfirmation>;
  captureBrowserState(): Promise<BrowserStateSnapshot>;
  close(): Promise<void>;
}

export interface PaymentStore {
  acquireLease(now: Date): Promise<RunLease>;
  renewLease(leaseId: string, now: Date): Promise<void>;
  releaseLease(leaseId: string): Promise<void>;
  findBlockingIntent(): Promise<PaymentIntent | undefined>;
  isFingerprintConfirmed(fingerprint: string): Promise<boolean>;
  beginIntent(
    leaseId: string,
    fingerprint: string,
    review: PaymentReview,
    now: Date,
  ): Promise<PaymentIntent>;
  confirmIntent(
    intentId: string,
    confirmation: PaymentConfirmation,
    now: Date,
  ): Promise<void>;
  markIntentUnknown(intentId: string, now: Date): Promise<void>;
}
