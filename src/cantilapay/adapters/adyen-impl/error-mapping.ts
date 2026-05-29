/* ============================================================
   Map Adyen refusal reasons onto cantilapay decline codes.
   Source: https://docs.adyen.com/development-resources/refusal-reasons
   ============================================================ */

export interface MappedRefusal {
  errorCode: string;
  declineCode: string;
  message: string;
}

const BY_CODE: Record<string, MappedRefusal> = {
  // 2 — Refused (generic)
  "2": {
    errorCode: "card_declined",
    declineCode: "generic_decline",
    message: "Your card was declined.",
  },
  // 4 — Acquirer Error
  "4": {
    errorCode: "processing_error",
    declineCode: "acquirer_error",
    message: "Your card could not be processed by the acquirer.",
  },
  // 5 — Blocked Card
  "5": {
    errorCode: "card_declined",
    declineCode: "blocked_card",
    message: "Your card has been blocked.",
  },
  // 6 — Expired Card
  "6": {
    errorCode: "expired_card",
    declineCode: "expired_card",
    message: "Your card has expired.",
  },
  // 7 — Invalid Amount
  "7": {
    errorCode: "invalid_amount",
    declineCode: "invalid_amount",
    message: "The amount is invalid.",
  },
  // 8 — Invalid Card Number
  "8": {
    errorCode: "incorrect_number",
    declineCode: "incorrect_number",
    message: "The card number is invalid.",
  },
  // 9 — Issuer Unavailable
  "9": {
    errorCode: "processing_error",
    declineCode: "issuer_unavailable",
    message: "Your card's issuing bank is unavailable.",
  },
  // 10 — Not supported
  "10": {
    errorCode: "card_declined",
    declineCode: "not_supported",
    message: "Your card is not supported.",
  },
  // 11 — 3D Not Authenticated
  "11": {
    errorCode: "authentication_required",
    declineCode: "authentication_required",
    message: "3D Secure authentication failed.",
  },
  // 12 — Not enough balance
  "12": {
    errorCode: "card_declined",
    declineCode: "insufficient_funds",
    message: "Your card has insufficient funds.",
  },
  // 14 — Acquirer Fraud
  "14": {
    errorCode: "card_declined",
    declineCode: "fraudulent",
    message: "Your card was flagged for fraud.",
  },
  // 15 — Cancelled
  "15": {
    errorCode: "card_declined",
    declineCode: "transaction_cancelled",
    message: "The payment was cancelled.",
  },
  // 22 — Pending
  "22": {
    errorCode: "processing_error",
    declineCode: "pending",
    message: "The payment is pending.",
  },
};

const BY_REASON: Record<string, string> = {
  "Refused": "2",
  "Acquirer Error": "4",
  "Blocked Card": "5",
  "Expired Card": "6",
  "Invalid Amount": "7",
  "Invalid Card Number": "8",
  "Issuer Unavailable": "9",
  "Not supported": "10",
  "3D Not Authenticated": "11",
  "Not enough balance": "12",
  "Acquirer Fraud": "14",
  "Cancelled": "15",
  "Pending": "22",
};

export function mapAdyenRefusalReason(input: {
  refusalReasonCode?: string;
  refusalReason?: string;
}): MappedRefusal {
  const direct = input.refusalReasonCode ? BY_CODE[input.refusalReasonCode] : undefined;
  if (direct) return direct;
  const fromReason = input.refusalReason ? BY_REASON[input.refusalReason] : undefined;
  if (fromReason && BY_CODE[fromReason]) return BY_CODE[fromReason];
  return {
    errorCode: "card_declined",
    declineCode: "generic_decline",
    message: input.refusalReason ?? "Your card was declined.",
  };
}
