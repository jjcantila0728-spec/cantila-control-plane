/* ============================================================
   Adyen Checkout API — payments lifecycle:
     - confirmPayment → POST /payments
     - capturePayment → POST /payments/{psp}/captures
     - refundPayment  → POST /payments/{psp}/refunds
     - cancelPayment  → POST /payments/{psp}/cancels

   For Adyen for Platforms (split between sub-merchant + platform
   liable balance account), every confirm carries a `splits[]`
   array that routes funds to the sub-merchant and the platform
   fee to our liable balance.
   ============================================================ */

import { randomUUID } from "node:crypto";
import type {
  PspCancelResult,
  PspCaptureResult,
  PspConfirmResult,
  PspRefundResult,
} from "../port";
import type { CantilapayMode } from "../../types";
import type { AdyenClients } from "./client";
import { mapAdyenRefusalReason } from "./error-mapping";
import type { Split } from "@adyen/api-library/lib/src/typings/checkout/split";
import type { CardDetails } from "@adyen/api-library/lib/src/typings/checkout/cardDetails";
import { PaymentRefundRequest } from "@adyen/api-library/lib/src/typings/checkout/paymentRefundRequest";

/** Map cantilapay's free-form refund `reason` to Adyen's
 *  constrained `MerchantRefundReasonEnum`. Unmappable strings
 *  fall through as undefined (Adyen accepts no reason). */
function mapRefundReason(
  reason: string | undefined,
): PaymentRefundRequest.MerchantRefundReasonEnum | undefined {
  if (!reason) return undefined;
  switch (reason.toLowerCase().replace(/[_-]/g, "")) {
    case "fraudulent":
    case "fraud":
      return PaymentRefundRequest.MerchantRefundReasonEnum.Fraud;
    case "requestedbycustomer":
    case "customerrequest":
      return PaymentRefundRequest.MerchantRefundReasonEnum.CustomerRequest;
    case "return":
      return PaymentRefundRequest.MerchantRefundReasonEnum.Return;
    case "duplicate":
      return PaymentRefundRequest.MerchantRefundReasonEnum.Duplicate;
    default:
      return PaymentRefundRequest.MerchantRefundReasonEnum.Other;
  }
}

/** Build the platform-fee + sub-merchant splits Adyen expects. */
function buildSplits(args: {
  subMerchantBalanceAccountId: string;
  liableBalanceAccountId: string;
  amountMinor: number;
  platformFeeMinor: number;
  reference: string;
}): Array<Split> {
  const splits: Array<Split> = [
    {
      type: "PaymentFee" as Split["type"],
      account: args.liableBalanceAccountId,
      amount: { value: args.platformFeeMinor },
      reference: `${args.reference}_fee`,
    },
    {
      type: "BalanceAccount" as Split["type"],
      account: args.subMerchantBalanceAccountId,
      amount: { value: args.amountMinor - args.platformFeeMinor },
      reference: `${args.reference}_balance`,
    },
  ];
  return splits;
}

export async function confirmPayment(
  clients: AdyenClients,
  input: {
    subMerchantId: string;
    paymentIntentId: string;
    amount: number;
    currency: string;
    paymentMethodToken: string;
    captureMode: "automatic" | "manual";
    mode: CantilapayMode;
    platformFeeAmount: number;
    metadata?: Record<string, string>;
  },
): Promise<PspConfirmResult> {
  // `subMerchantId` carries the BalanceAccount id of the tenant — see
  // submerchants.ts (Task 10) for how it's persisted on the cantilapay
  // account row.
  const reference = input.paymentIntentId;
  const splits = buildSplits({
    subMerchantBalanceAccountId: input.subMerchantId,
    liableBalanceAccountId: clients.liableBalanceAccountId,
    amountMinor: input.amount,
    platformFeeMinor: input.platformFeeAmount,
    reference,
  });
  try {
    const response = await clients.checkout.PaymentsApi.payments(
      {
        merchantAccount: clients.merchantAccount,
        reference,
        amount: {
          currency: input.currency.toUpperCase(),
          value: input.amount,
        },
        paymentMethod: {
          type: "scheme" as CardDetails.TypeEnum,
          storedPaymentMethodId: input.paymentMethodToken,
        } as CardDetails,
        // returnUrl is required by the SDK type declaration but is not
        // triggered for server-to-server stored-card payments. Provide a
        // non-empty sentinel so the type checker is satisfied; Adyen will
        // only use it if a redirect/3DS challenge is raised (handled in
        // Phase 4 via Drop-in).
        returnUrl: "https://api.cantila.app/v1/cantilapay/3ds-return",
        // Automatic vs manual capture is signalled by `captureDelayHours`.
        // 0 = manual (no auto capture); not-set = automatic.
        captureDelayHours:
          input.captureMode === "manual" ? 0 : undefined,
        splits,
        metadata: input.metadata,
      },
      { idempotencyKey: randomUUID() },
    );
    const resultCode = response.resultCode;
    const pspPaymentRef = response.pspReference ?? "";
    switch (resultCode) {
      case "Authorised":
        return {
          pspPaymentRef,
          status:
            input.captureMode === "manual"
              ? "authorized_pending_capture"
              : "succeeded",
        };
      case "Received":
      case "Pending":
        return { pspPaymentRef, status: "authorized_pending_capture" };
      case "Refused":
      case "Error":
      case "Cancelled": {
        const mapped = mapAdyenRefusalReason({
          refusalReasonCode: response.refusalReasonCode,
          refusalReason: response.refusalReason,
        });
        return {
          pspPaymentRef,
          status: "failed",
          errorCode: mapped.errorCode,
          declineCode: mapped.declineCode,
          errorMessage: mapped.message,
        };
      }
      case "RedirectShopper":
      case "ChallengeShopper":
      case "IdentifyShopper":
        // 3DS / SCA challenge — Phase 4 hosted Checkout handles this
        // path via Drop-in. For the server-to-server v1.1.0 path we
        // surface it but do not attempt to drive the challenge.
        return {
          pspPaymentRef,
          status: "requires_action",
          actionPayload: response.action,
        };
      default:
        return {
          pspPaymentRef,
          status: "failed",
          errorCode: "unknown_result_code",
          errorMessage: `Adyen returned resultCode='${resultCode}'`,
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      pspPaymentRef: "",
      status: "failed",
      errorCode: "adyen_request_failed",
      errorMessage: msg,
    };
  }
}

export async function capturePayment(
  clients: AdyenClients,
  input: { pspPaymentRef: string; amount: number; currency: string },
): Promise<PspCaptureResult> {
  try {
    const response = await clients.checkout.ModificationsApi.captureAuthorisedPayment(
      input.pspPaymentRef,
      {
        merchantAccount: clients.merchantAccount,
        amount: {
          currency: input.currency.toUpperCase(),
          value: input.amount,
        },
        reference: `capture_${input.pspPaymentRef}`,
      },
      { idempotencyKey: randomUUID() },
    );
    // Adyen returns status='received' on accept; the actual capture
    // result arrives via the CAPTURE notification later.
    return {
      pspCaptureRef: response.pspReference ?? "",
      status: response.status === "received" ? "pending" : "succeeded",
    };
  } catch (err) {
    return {
      pspCaptureRef: "",
      status: "failed",
      errorCode: "adyen_request_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function refundPayment(
  clients: AdyenClients,
  input: {
    pspPaymentRef: string;
    amount: number;
    currency: string;
    reason?: string;
  },
): Promise<PspRefundResult> {
  try {
    const response = await clients.checkout.ModificationsApi.refundCapturedPayment(
      input.pspPaymentRef,
      {
        merchantAccount: clients.merchantAccount,
        amount: {
          currency: input.currency.toUpperCase(),
          value: input.amount,
        },
        reference: `refund_${input.pspPaymentRef}`,
        merchantRefundReason: mapRefundReason(input.reason),
      },
      { idempotencyKey: randomUUID() },
    );
    return {
      pspRefundRef: response.pspReference ?? "",
      status: response.status === "received" ? "pending" : "succeeded",
    };
  } catch (err) {
    return {
      pspRefundRef: "",
      status: "failed",
      errorCode: "adyen_request_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function cancelPayment(
  clients: AdyenClients,
  input: { pspPaymentRef: string },
): Promise<PspCancelResult> {
  try {
    const response = await clients.checkout.ModificationsApi.cancelAuthorisedPaymentByPspReference(
      input.pspPaymentRef,
      {
        merchantAccount: clients.merchantAccount,
        reference: `cancel_${input.pspPaymentRef}`,
      },
      { idempotencyKey: randomUUID() },
    );
    return {
      status: response.status === "received" ? "succeeded" : "succeeded",
    };
  } catch (err) {
    return {
      status: "failed",
      errorCode: "adyen_request_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
