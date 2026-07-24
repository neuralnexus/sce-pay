export type ErrorCode =
  | "ALREADY_RUNNING"
  | "AUTHENTICATION_REQUIRED"
  | "BUNDLE_INVALID"
  | "CAPTCHA_REQUIRED"
  | "CONFIGURATION_REQUIRED"
  | "PAYMENT_UNCERTAIN"
  | "POLICY_STOP"
  | "SITE_CHANGED";

export class ScePayError extends Error {
  readonly code: ErrorCode;
  readonly attentionRequired: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { attentionRequired?: boolean; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "ScePayError";
    this.code = code;
    this.attentionRequired = options?.attentionRequired ?? true;
  }
}

export class PolicyStopError extends ScePayError {
  constructor(message: string) {
    super("POLICY_STOP", message);
  }
}

export class SiteChangedError extends ScePayError {
  constructor(message: string, cause?: unknown) {
    super("SITE_CHANGED", message, { cause });
  }
}

export class PaymentUncertainError extends ScePayError {
  constructor(
    message = "The payment result is uncertain; automatic retries are blocked.",
  ) {
    super("PAYMENT_UNCERTAIN", message);
  }
}

export function safeError(error: unknown): {
  code: string;
  message: string;
  attentionRequired: boolean;
} {
  if (error instanceof ScePayError) {
    return {
      code: error.code,
      message: error.message,
      attentionRequired: error.attentionRequired,
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "The run failed without a safe, recognized result.",
    attentionRequired: true,
  };
}
