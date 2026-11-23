/**
 * Session-scoped MCP server that exposes Pi's current tools to an ACP agent
 * over a local authenticated HTTP endpoint (paired with `mcp-stdio-shim.mjs`
 * for ACP adapters that only support stdio `mcpServers`).
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import { isRecord, RPC_INTERNAL_ERROR, RPC_INVALID_PARAMS, RPC_METHOD_NOT_FOUND } from "./acp.ts";
import type { McpServerConfig } from "./acp-client.ts";
import type { ToolHandoff } from "./tool-handoff.ts";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SHIM_PATH = fileURLToPath(new URL("./mcp-stdio-shim.mjs", import.meta.url));

export interface McpToolResult {
	content: { type: "text"; text: string }[];
	isError: boolean;
}

/** Converts a Pi `ToolResultMessage` into an MCP `tools/call` result. */
export function toMcpToolResult(result: ToolResultMessage): McpToolResult {
	const content = result.content.flatMap((block): { type: "text"; text: string }[] =>
		block.type === "text"
			? [{ type: "text", text: block.text }]
			: [{ type: "text", text: `[image ${block.mimeType} omitted]` }],
	);
	if (content.length === 0) content.push({ type: "text", text: result.isError ? "Tool failed" : "" });
	return { content, isError: result.isError };
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function sendJson(res: ServerResponse, status: number, body?: unknown): void {
	if (body === undefined) {
		res.writeHead(status);
		res.end();
		return;
	}
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json" });
	res.end(payload);
}

export class McpBridge {
	private readonly token = randomBytes(24).toString("hex");
	private server: Server | null = null;
	private listening: Promise<string> | null = null;
	private tools: Tool[] = [];
	private handoff: ToolHandoff | null = null;
	private turnSignal: AbortSignal | undefined;
	private nextCallId = 1;
	private closed = false;

	setTools(tools: readonly Tool[]): void {
		this.tools = tools.map((tool) => toToolDeclaration(tool));
	}

	setHandoff(handoff: ToolHandoff, signal?: AbortSignal): void {
		this.handoff = handoff;
		this.turnSignal = signal;
	}

	clearHandoff(handoff: ToolHandoff): void {
		if (this.handoff === handoff) {
			this.handoff = null;
			this.turnSignal = undefined;
		}
	}

	async serverConfig(): Promise<McpServerConfig> {
		const url = await this.ensureListening();
		return {
			name: "pi",
			command: process.execPath,
			args: [SHIM_PATH],
			env: [
				{ name: "PI_ACP_MCP_URL", value: url },
				{ name: "PI_ACP_MCP_TOKEN", value: this.token },
			],
		};
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.handoff = null;
		this.turnSignal = undefined;
		this.server?.close();
		this.server = null;
		this.listening = null;
	}

	private ensureListening(): Promise<string> {
		if (this.closed) return Promise.reject(new Error("MCP bridge was closed"));
		if (this.listening) return this.listening;
		const server = createServer((req, res) => {
			void this.handleHttp(req, res);
		});
		this.server = server;
		this.listening = new Promise<string>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				const address = server.address();
				if (!address || typeof address === "string") {
					reject(new Error("Failed to bind MCP bridge"));
					return;
				}
				resolve(`http://127.0.0.1:${address.port}/mcp`);
			});
		});
		return this.listening;
	}

	private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.headers.authorization !== `Bearer ${this.token}`) {
			sendJson(res, 401, { error: "Unauthorized" });
			return;
		}
		if (req.method !== "POST") {
			sendJson(res, 405, { error: "Method not allowed" });
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readBody(req));
		} catch {
			sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
			return;
		}
		if (!isRecord(parsed) || typeof parsed.method !== "string") {
			sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: RPC_INVALID_PARAMS, message: "Invalid JSON-RPC" } });
			return;
		}
		const id = parsed.id;
		const isNotification = id === undefined || id === null;
		if (isNotification) {
			sendJson(res, 202);
			return;
		}
		try {
			const result = await this.dispatch(parsed.method, parsed.params);
			sendJson(res, 200, { jsonrpc: "2.0", id, result });
		} catch (error) {
			const code = error instanceof McpRpcError ? error.code : RPC_INTERNAL_ERROR;
			const message = error instanceof Error ? error.message : String(error);
			sendJson(res, 200, { jsonrpc: "2.0", id, error: { code, message } });
		}
	}

	private async dispatch(method: string, params: unknown): Promise<unknown> {
		switch (method) {
			case "initialize":
				return {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "pi-tools", version: "1.0.0" },
				};
			case "ping":
				return {};
			case "tools/list":
				return {
					tools: this.tools.map((tool) => ({
						name: tool.name,
						description: tool.description,
						inputSchema: tool.parameters,
					})),
				};
			case "tools/call": {
				if (!isRecord(params) || typeof params.name !== "string") {
					throw new McpRpcError("tools/call requires a tool name", RPC_INVALID_PARAMS);
				}
				const tool = this.tools.find((candidate) => candidate.name === params.name);
				if (!tool) {
					return {
						content: [{ type: "text", text: `Tool '${params.name}' is not available in this Pi session.` }],
						isError: true,
					};
				}
				const handoff = this.handoff;
				if (!handoff) {
					return {
						content: [{ type: "text", text: "No active Pi turn is available to execute tools." }],
						isError: true,
					};
				}
				const args = isRecord(params.arguments) ? params.arguments : {};
				const callId = `mcp_${this.nextCallId++}`;
				const result = await handoff.request({ id: callId, name: params.name, arguments: args }, this.turnSignal);
				if (isRecord(result) && Array.isArray(result.content) && typeof result.isError === "boolean") {
					return result;
				}
				return {
					content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
					isError: false,
				};
			}
			default:
				throw new McpRpcError(`Method '${method}' not found`, RPC_METHOD_NOT_FOUND);
		}
	}
}

class McpRpcError extends Error {
	readonly code: number;
	constructor(message: string, code: number) {
		super(message);
		this.code = code;
	}
}
