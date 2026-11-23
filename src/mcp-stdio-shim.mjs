/**
 * Minimal stdio-to-HTTP JSON-RPC bridge for ACP `mcpServers`.
 * Reads NDJSON requests/notifications from stdin, POSTs them to the
 * session-scoped MCP server in pi-acp-provider, and writes responses to stdout.
 */
import { createInterface } from "node:readline";

const url = process.env.PI_ACP_MCP_URL;
const token = process.env.PI_ACP_MCP_TOKEN;
if (!url || !token) {
	process.stderr.write("PI_ACP_MCP_URL and PI_ACP_MCP_TOKEN are required\n");
	process.exit(1);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let closed = false;
rl.on("close", () => {
	closed = true;
});

async function forward(line) {
	if (!line.trim()) return;
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch {
		return;
	}
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
			},
			body: line,
		});
		const text = await res.text();
		if (text.trim()) process.stdout.write(`${text.trim()}\n`);
	} catch (error) {
		if (parsed && typeof parsed === "object" && "id" in parsed && parsed.id !== undefined) {
			const msg = error instanceof Error ? error.message : String(error);
			process.stdout.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, error: { code: -32603, message: msg } })}\n`,
			);
		}
	}
	if (closed) process.exit(0);
}

rl.on("line", (line) => {
	void forward(line);
});
