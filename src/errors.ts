export type ErrorCode =
  | "AUTH_REQUIRED"
  | "CAPTCHA_REQUIRED"
  | "CONFIG_INVALID"
  | "LOCKED"
  | "PAYMENT_UNCERTAIN"
  | "SAFETY_STOP"
  | "SITE_CHANGED"
  | "UNSUPPORTED_PLATFORM";

export class ScePayError extends Error {
  readonly code: ErrorCode;
  readonly remediation: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { cause?: unknown; remediation?: string },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.remediation = options?.remediation;
  }
}

export class SafetyStopError extends ScePayError {
  constructor(message: string, remediation?: string) {
    super("SAFETY_STOP", message, {
      ...(remediation === undefined ? {} : { remediation }),
    });
  }
}

export class SiteChangedError extends ScePayError {
  constructor(message: string, remediation?: string) {
    super("SITE_CHANGED", message, {
      ...(remediation === undefined ? {} : { remediation }),
    });
  }
}

export class AuthenticationRequiredError extends ScePayError {
  constructor(message = "The saved SCE browser session needs attention.") {
    super("AUTH_REQUIRED", message, {
      remediation: "Run `sce-pay login`, complete sign-in, then rerun the check.",
    });
  }
}

export class CaptchaRequiredError extends ScePayError {
  constructor() {
    super("CAPTCHA_REQUIRED", "SCE's current payment flow requested a CAPTCHA.", {
      remediation:
        "Run `sce-pay login` and complete the challenge manually. CAPTCHA bypass is intentionally unsupported.",
    });
  }
}

export class PaymentSubmissionUncertainError extends ScePayError {
  constructor(message: string, cause?: unknown) {
    super("PAYMENT_UNCERTAIN", message, {
      cause,
      remediation:
        "Check SCE payment history before reconciling this intent. Do not retry until its status is known.",
    });
  }
}
