/* JSON-RPC 2.0 — the wire format the Model Context Protocol rides on. */

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const JSON_RPC_INTERNAL_ERROR = -32603;
