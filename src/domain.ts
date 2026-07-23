import type { BrowserContextOptions } from "@cloudflare/playwright";

export interface GuestBundle {
  version: 1;
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
  storageState: NonNullable<BrowserContextOptions["storageState"]>;
  sessionStorageByOrigin: Record<string, Record<string, string>>;
  notificationWebhookUrl?: string;
}

export interface EncryptedBundle {
  version: 1;
  algorithm: "AES-GCM";
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
  activeRun: boolean;
  blockingIntent?: PaymentIntent;
  lastRun?: RunRecord;
  confirmedPayments: PaymentIntent[];
}

export interface RunRecord {
  at: string;
  source: "cron" | "manual";
  dryRun: boolean;
  outcome: string;
  message: string;
}

export type WorkflowOutcome =
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

export interface PortalClient {
  inspectBill(): Promise<BillSnapshot | null>;
  preparePayment(bill: BillSnapshot): Promise<PaymentReview>;
  submitPayment(
    onWillSubmit: () => Promise<void>,
  ): Promise<PaymentConfirmation>;
  close(): Promise<void>;
}

export interface PaymentStore {
  acquireLease(now: Date): Promise<RunLease>;
  releaseLease(leaseId: string): Promise<void>;
  findBlockingIntent(): Promise<PaymentIntent | undefined>;
  isFingerprintConfirmed(fingerprint: string): Promise<boolean>;
  beginIntent(
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
