export type BillSnapshot = {
  accountReference: string;
  amountCents: number;
  dueDate: string;
  observedAt: string;
};

export type PaymentReview = {
  accountReference: string;
  amountCents: number;
  feeCents: number;
  totalCents: number;
  dueDate: string;
  paymentMethodLast4: string;
};

export type PaymentConfirmation = {
  confirmationNumber: string;
  paidAt: string;
};

export type PortalClient = {
  inspectBill(): Promise<BillSnapshot | null>;
  preparePayment(
    bill: BillSnapshot,
    paymentMethodLast4: string,
  ): Promise<PaymentReview>;
  submitPayment(onWillSubmit: () => Promise<void>): Promise<PaymentConfirmation>;
  close(): Promise<void>;
};

export type Clock = {
  now(): Date;
};

export const systemClock: Clock = {
  now: () => new Date(),
};

export type RunOutcome =
  | {
      status: "no-bill" | "already-paid" | "not-due" | "observed";
      message: string;
    }
  | {
      status: "dry-run";
      message: string;
      review: PaymentReview;
    }
  | {
      status: "paid";
      message: string;
      confirmation: PaymentConfirmation;
      review: PaymentReview;
    };
