import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import Type from "typebox";
import { McpBridge } from "../src/mcp-bridge.ts";
import { createAcpProvider, type AcpProviderHandle } from "../src/provider.ts";
import { ToolHandoff } from "../src/tool-handoff.ts";

const fakePath = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));

function makeProvider() {
	return createAcpProvider({
		config: {
			agents: [{ id: "fake", name: "Fake agent", command: process.execPath, args: [fakePath], env: {}, authMethod: undefined }],
			autoApproveTools: true,
			freshSessionOnInstructionChange: "ask",
			handshakeTimeoutMs: 8000,
			debug: false,
		},
	});
}

function makeAgent(handle: AcpProviderHandle, sessionId: string, tools: AgentTool<any>[]) {
	const model = handle.provider.getModels()[0];
	assert.ok(model);
	return new Agent({
		initialState: { model, tools },
		sessionId,
		streamFn: (m, ctx, opts) => handle.provider.streamSimple(m, ctx, opts),
	});
}

function assistantText(agent: Agent) {
	const msg = agent.state.messages.findLast((m) => m.role === "assistant");
	return (msg?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

test("McpBridge enforces auth, lists tools, and forwards or denies tools/call", async () => {
	const bridge = new McpBridge();
	const handoff = new ToolHandoff();
	bridge.setTools([
		{ name: "echo_tool", description: "Echoes text", parameters: Type.Object({ text: Type.String() }) },
	]);
	bridge.setHandoff(handoff);
	try {
		const cfg = await bridge.serverConfig();
		const url = cfg.env.find((e) => e.name === "PI_ACP_MCP_URL")?.value;
		const token = cfg.env.find((e) => e.name === "PI_ACP_MCP_TOKEN")?.value;
		assert.ok(url && token);

		const unauth = await fetch(url, { method: "POST", body: "{}" });
		assert.equal(unauth.status, 401);

		const listRes = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		const listJson = (await listRes.json()) as { result: { tools: { name: string }[] } };
		assert.deepEqual(listJson.result.tools.map((t) => t.name), ["echo_tool"]);

		const deniedRes = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "missing_tool", arguments: {} } }),
		});
		const deniedJson = (await deniedRes.json()) as { result: { isError: boolean } };
		assert.equal(deniedJson.result.isError, true);

		const callPromise = fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo_tool", arguments: { text: "hi" } } }),
		}).then((r) => r.json() as Promise<{ result: { isError: boolean; content: { text: string }[] } }>);
		const call = await handoff.next();
		assert.equal(call?.name, "echo_tool");
		handoff.complete(call!.id, { content: [{ type: "text", text: "ok:hi" }], isError: false });
		const callJson = await callPromise;
		assert.equal(callJson.result.isError, false);
		assert.equal(callJson.result.content[0]?.text, "ok:hi");
	} finally {
		handoff.close();
		bridge.close();
	}
});

test("provider MCP bridge executes Pi tools and returns results to the ACP agent", async () => {
	const handle = makeProvider();
	let executions = 0;
	const agent = makeAgent(handle, "mcp-success", [
		{
			name: "probe_tool",
			label: "Probe",
			description: "Echo input",
			parameters: Type.Object({ input: Type.String() }),
			execute: async (_id: string, args: unknown) => {
				executions++;
				const input = (args as { input: string }).input;
				return { content: [{ type: "text", text: `pi:${input}` }], details: {} };
			},
		},
	]);
	try {
		await agent.prompt('MCP probe_tool {"input":"hello"}');
		assert.equal(executions, 1);
		assert.equal(assistantText(agent), "mcp:false:pi:hello");
		assert.ok(agent.state.messages.some((m) => m.role === "toolResult" && !m.isError));
	} finally {
		handle.dispose();
	}
});

test("provider MCP bridge surfaces Pi tool errors/denials back to the ACP agent", async () => {
	const handle = makeProvider();
	const agent = makeAgent(handle, "mcp-denial", [
		{
			name: "probe_tool",
			label: "Probe",
			description: "Always denies",
			parameters: Type.Object({ input: Type.String() }),
			execute: async () => {
				throw new Error("permission denied");
			},
		},
	]);
	try {
		await agent.prompt('MCP probe_tool {"input":"secret"}');
		assert.equal(assistantText(agent), "mcp:true:permission denied");
		assert.ok(agent.state.messages.some((m) => m.role === "toolResult" && m.isError));
	} finally {
		handle.dispose();
	}
});

test("overlapping sessions keep MCP tool calls and results isolated", async () => {
	const handle = makeProvider();
	const makeEchoTool = (tag: string): AgentTool<any> => ({
		name: "probe_tool",
		label: "Probe",
		description: "Echo with tag",
		parameters: Type.Object({ input: Type.String() }),
		execute: async (_id: string, args: unknown) => ({
			content: [{ type: "text" as const, text: `${tag}:${(args as { input: string }).input}` }],
			details: {},
		}),
	});
	const left = makeAgent(handle, "mcp-left", [makeEchoTool("L")]);
	const right = makeAgent(handle, "mcp-right", [makeEchoTool("R")]);
	try {
		await Promise.all([
			left.prompt('MCP probe_tool {"input":"one"}'),
			right.prompt('MCP probe_tool {"input":"two"}'),
		]);
		assert.equal(assistantText(left), "mcp:false:L:one");
		assert.equal(assistantText(right), "mcp:false:R:two");
	} finally {
		handle.dispose();
	}
});

test("aborting a Pi tool execution cancels the ACP turn cleanly and session survives", async () => {
	const handle = makeProvider();
	let started!: () => void;
	const toolStarted = new Promise<void>((resolve) => { started = resolve; });
	const agent = makeAgent(handle, "mcp-abort", [
		{
			name: "slow_tool",
			label: "Slow",
			description: "Waits until aborted",
			parameters: Type.Object({}),
			execute: async (_id: string, _args: unknown, signal?: AbortSignal) => {
				started();
				await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
				throw new Error("aborted");
			},
		},
	]);
	try {
		const running = agent.prompt("MCP slow_tool {}");
		await toolStarted;
		agent.abort();
		await running;
		handle.disposeSession("mcp-abort");
		await agent.prompt("ECHO recovered");
		assert.equal(assistantText(agent), "recovered");
	} finally {
		handle.dispose();
	}
});

test("ACP crash mid-MCP tool call surfaces error and next prompt recovers", async () => {
	const handle = makeProvider();
	const agent = makeAgent(handle, "mcp-crash", [
		{
			name: "slow_tool",
			label: "Slow",
			description: "Waits briefly",
			parameters: Type.Object({}),
			execute: async () => {
				await new Promise((resolve) => setTimeout(resolve, 100));
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		},
	]);
	try {
		await agent.prompt("MCP_CRASH slow_tool {}");
		const last = agent.state.messages.findLast((m) => m.role === "assistant");
		assert.equal(last?.stopReason, "error");
		await agent.prompt("ECHO back");
		assert.equal(assistantText(agent), "back");
	} finally {
		handle.dispose();
	}
});

test("bridged calls obey the session Pi tool allowlist across turns", async () => {
	const handle = makeProvider();
	let writes = 0;
	const readTool: AgentTool<any> = {
		name: "read_only",
		label: "Read",
		description: "Read-only tool",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
	const agent = makeAgent(handle, "mcp-restrict", [readTool]);
	try {
		await agent.prompt("MCP write_file {}");
		assert.equal(writes, 0);
		assert.equal(assistantText(agent), "mcp:true:Tool 'write_file' is not available in this Pi session.");

		// Removing all tools on a later turn also removes them from the session's McpBridge.
		agent.state.tools = [];
		await agent.prompt("MCP read_only {}");
		assert.equal(assistantText(agent), "mcp:true:Tool 'read_only' is not available in this Pi session.");
	} finally {
		handle.dispose();
	}
});
