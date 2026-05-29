/* ============================================================
   Cantilapay — error model (plan §25, Phase 0).

   Mirrors Stripe's error shape so SDKs feel familiar to a
   developer migrating from Stripe:

     {
       "error": {
         "type":    "<category>",
         "code":    "<machine-readable>",
         "message": "<human-readable>",
         "param":   "<field name, optional>",
         "request_id": "<req_…>"
       }
     }

   The `type` mirrors Stripe's top-level categories. We intentionally
   do not 1:1 copy every Stripe `code` — instead we mint cantilapay
   codes that match cantilapay's own state machine. The `message` is
   what the tenant reads in their logs.
   ============================================================ */

/** Stripe-shaped error category. */
export type CantilapayErrorType =
  | "api_error" // platform bug; would be a Cantila incident
  | "invalid_request_error" // bad input from the tenant
  | "authentication_error" // missing or revoked key
  | "permission_error" // wrong key kind / mode for this route
  | "rate_limit_error" // throttled
  | "idempotency_error" // key reused with different body
  | "card_error" // PSP declined / 3DS failed (Phase 1+)
  | "resource_missing"; // 404

/** All cantilapay-emitted error codes in one place. Keep alphabetised
 *  within each section so renames are obvious in diffs. */
export const CANTILAPAY_ERROR_CODE = {
  // authentication / permission
  invalid_api_key: "invalid_api_key",
  missing_api_key: "missing_api_key",
  revoked_api_key: "revoked_api_key",
  mode_mismatch: "mode_mismatch",
  kind_mismatch: "kind_mismatch",
  account_inactive: "account_inactive",

  // request shape
  invalid_field: "invalid_field",
  missing_field: "missing_field",
  resource_missing: "resource_missing",
  idempotency_body_mismatch: "idempotency_body_mismatch",

  // platform
  internal_error: "internal_error",
  rate_limited: "rate_limited",

  // live-mode prod guard
  live_mode_not_acknowledged: "live_mode_not_acknowledged",
} as const;

export type CantilapayErrorCode =
  (typeof CANTILAPAY_ERROR_CODE)[keyof typeof CANTILAPAY_ERROR_CODE];

export interface CantilapayErrorBody {
  type: CantilapayErrorType;
  code: CantilapayErrorCode;
  message: string;
  /** The offending request field, when applicable. */
  param?: string;
  /** Server-issued request id (always set on the response). */
  requestId?: string;
}

export interface CantilapayErrorResponse {
  error: CantilapayErrorBody;
}

/** Construct a thrown error carrying the wire shape. Routes catch
 *  these and turn them into the right HTTP status. */
export class CantilapayError extends Error {
  readonly status: number;
  readonly body: CantilapayErrorBody;

  constructor(
    status: number,
    body: CantilapayErrorBody,
  ) {
    super(body.message);
    this.name = "CantilapayError";
    this.status = status;
    this.body = body;
  }

  /** 401 — no key on the request. */
  static missingKey(): CantilapayError {
    return new CantilapayError(401, {
      type: "authentication_error",
      code: CANTILAPAY_ERROR_CODE.missing_api_key,
      message:
        "Missing API key. Send your `csk_test_…` or `csk_live_…` secret key as a Bearer token in the Authorization header.",
    });
  }

  /** 401 — bearer present but doesn't resolve to a key row. */
  static invalidKey(): CantilapayError {
    return new CantilapayError(401, {
      type: "authentication_error",
      code: CANTILAPAY_ERROR_CODE.invalid_api_key,
      message:
        "Invalid API key. The key you supplied does not exist or has been deleted.",
    });
  }

  /** 401 — key is marked revoked. */
  static revokedKey(): CantilapayError {
    return new CantilapayError(401, {
      type: "authentication_error",
      code: CANTILAPAY_ERROR_CODE.revoked_api_key,
      message:
        "This API key has been revoked. Issue a new one from the Cantila Console.",
    });
  }

  /** 403 — wrong kind (e.g. publishable on a server-only route). */
  static kindMismatch(): CantilapayError {
    return new CantilapayError(403, {
      type: "permission_error",
      code: CANTILAPAY_ERROR_CODE.kind_mismatch,
      message:
        "This route requires a secret API key (`csk_…`). Publishable keys (`cpk_…`) cannot perform mutations.",
    });
  }

  /** 403 — sub-merchant not yet approved on this mode. */
  static accountInactive(): CantilapayError {
    return new CantilapayError(403, {
      type: "permission_error",
      code: CANTILAPAY_ERROR_CODE.account_inactive,
      message:
        "Your cantilapay account is not active. Complete the onboarding flow before accepting payments.",
    });
  }

  /** 400 — Zod schema failure. */
  static invalidField(message: string, param?: string): CantilapayError {
    return new CantilapayError(400, {
      type: "invalid_request_error",
      code: CANTILAPAY_ERROR_CODE.invalid_field,
      message,
      param,
    });
  }

  /** 400 — same idempotency key, different body. */
  static idempotencyBodyMismatch(): CantilapayError {
    return new CantilapayError(400, {
      type: "idempotency_error",
      code: CANTILAPAY_ERROR_CODE.idempotency_body_mismatch,
      message:
        "Cantilapay-Idempotency-Key was reused with a different request body. The first response was preserved; retry with the original body or a fresh key.",
    });
  }

  /** 404. */
  static notFound(resource: string): CantilapayError {
    return new CantilapayError(404, {
      type: "resource_missing",
      code: CANTILAPAY_ERROR_CODE.resource_missing,
      message: `No such ${resource}.`,
    });
  }

  /** 500 — wrapped unexpected exception. */
  static internal(message = "Internal cantilapay error."): CantilapayError {
    return new CantilapayError(500, {
      type: "api_error",
      code: CANTILAPAY_ERROR_CODE.internal_error,
      message,
    });
  }

  /** 500 — live-mode prod guard tripped (CANTILAPAY_LIVE_ACK missing). */
  static liveModeNotAcknowledged(): CantilapayError {
    return new CantilapayError(500, {
      type: "api_error",
      code: CANTILAPAY_ERROR_CODE.live_mode_not_acknowledged,
      message:
        "Cantilapay live adapter cannot mount in production without CANTILAPAY_LIVE_ACK=1. Set the env var to acknowledge the live rail is intended.",
    });
  }
}
