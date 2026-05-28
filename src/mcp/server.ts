/* ============================================================
   A minimal, from-scratch Model Context Protocol server.
   Speaks JSON-RPC 2.0; the wire layer is transport-agnostic —
   `start()` reads newline-delimited messages from stdin (the
   local Claude Desktop case), and `handleRpc()` is the seam
   any other transport (HTTP, WebSocket) can call directly with
   one parsed message. (Plan §4.3.2 / §7.6 — the "remote MCP
   server" is the HTTP mounting of this same handler in
   `src/index.ts`.)
   ============================================================ */

import { type JsonRpcResponse, JSON_RPC_INTERNAL_ERROR } from "./protocol";

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema describing the tool's arguments. */
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

const PROTOCOL_VERSION = "2024-11-05";

export class McpServer {
  private tools = new Map<string, ToolDefinition>();

  constructor(private info: { name: string; version: string }) {}

  addTool(def: ToolDefinition): void {
    this.tools.set(def.name, def);
  }

  /** Begin reading newline-delimited JSON-RPC messages from stdin. */
  start(): void {
    let buffer = "";
    process.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) void this.handleLine(line);
        newline = buffer.indexOf("\n");
      }
    });
    process.stdin.on("end", () => process.exit(0));
  }

  /** Transport-agnostic entry point. The HTTP transport in `src/index.ts`
   *  calls this with a single parsed JSON-RPC message and returns the
   *  response (or null for notifications, which the HTTP layer translates
   *  to a 204). Same path the stdio transport uses internally. */
  async handleRpc(
    message: { id?: number | string; method?: string; params?: unknown },
  ): Promise<JsonRpcResponse | null> {
    // notifications (e.g. notifications/initialized) carry no id — no reply
    if (message.id === undefined || message.method === undefined) return null;
    const id = message.id;
    try {
      const result = await this.dispatch(
        message.method,
        (message.params ?? {}) as Record<string, unknown>,
      );
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: JSON_RPC_INTERNAL_ERROR,
          message: err instanceof Error ? err.message : "internal error",
        },
      };
    }
  }

  /** Expose tool metadata for a `GET /v1/mcp` info endpoint — handy for
   *  operators inspecting the remote server without speaking JSON-RPC. */
  describe(): {
    name: string;
    version: string;
    protocolVersion: string;
    tools: Array<{ name: string; description: string }>;
  } {
    return {
      name: this.info.name,
      version: this.info.version,
      protocolVersion: PROTOCOL_VERSION,
      tools: [...this.tools.values()].map((t) => ({
        name: t.name,
        description: t.description,
      })),
    };
  }

  private async handleLine(line: string): Promise<void> {
    let message: { id?: number | string; method?: string; params?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      return; // ignore unparseable input
    }
    const response = await this.handleRpc(message);
    if (response) this.reply(response);
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: this.info,
        };
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: [...this.tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        };
      case "tools/call": {
        const name = String(params.name ?? "");
        const tool = this.tools.get(name);
        if (!tool) throw new Error(`unknown tool: ${name}`);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        return await tool.handler(args);
      }
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  private reply(response: JsonRpcResponse): void {
    process.stdout.write(JSON.stringify(response) + "\n");
  }
}
