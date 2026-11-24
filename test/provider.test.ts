import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Message,
	Model,
	Api,
} from "@earendil-works/pi-ai";
import { createAcpProvider, fingerprintInstructions, type AcpProviderOptions, type AcpProviderHandle } from "../src/provider.ts";
import type { AcpAgentConfig } from "../src/config.ts";

const fakePath = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));

function fakeAgent(overrides: Partial<AcpAgentConfig> = {}): AcpAgentConfig {
	return {
		id: "fake",
		name: "Fake agent",
		command: process.execPath,
		args: [fakePath],
		env: {},
		authMethod: undefined,
		...overrides,
	};
}

const handles: AcpProviderHandle[] = [];
test.afterEach(() => {
	for (const handle of handles.splice(0)) handle.dispose();
});

function makeProvider(
	agents: AcpAgentConfig[] = [fakeAgent()],
	extra: Omit<AcpProviderOptions, "config"> & { freshSessionOnInstructionChange?: "ask" | "continue" | "fresh" | "restart" } = {},
): AcpProviderHandle {
	const { freshSessionOnInstructionChange = "ask", ...rest } = extra;
	const handle = createAcpProvider({
		config: {
			agents,
			autoApproveTools: true,
			freshSessionOnInstructionChange,
			handshakeTimeoutMs: 8000,
			debug: false,
		},
		...rest,
	});
	handles.push(handle);
	return handle;
}

function firstModel(handle: AcpProviderHandle): Model<Api> {
	const model = handle.provider.getModels()[0];
	assert.ok(model);
	return model;
}

function userContext(text: string) {
	const messages: Message[] = [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }];
	return normalizeContext({ messages });
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

async function lastEvent(handle: AcpProviderHandle, text: string, model = firstModel(handle)) {
	return (await collect(handle.provider.streamSimple(model, userContext(text), {}))).at(-1);
}

function messageText(message: AssistantMessage): string {
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

test("each configured agent is a model of the acp provider", () => {
	const handle = makeProvider([fakeAgent(), fakeAgent({ id: "other", name: "Other agent" })]);
	assert.equal(handle.provider.id, "acp");
	assert.deepEqual(
		handle.provider.getModels().map((model) => [model.provider, model.id, model.name]),
		[
			["acp", "fake", "Fake agent"],
			["acp", "other", "Other agent"],
		],
	);
});

test("happy path: ordered events, balanced blocks, zero usage", async () => {
	const handle = makeProvider();
	const events = await collect(handle.provider.streamSimple(firstModel(handle), userContext("hello there"), {}));
	const types = events.map((event) => event.type);

	assert.equal(types[0], "start");
	assert.equal(types.filter((type) => type === "start" || type === "done" || type === "error").length, 2);
	for (const kind of ["text", "thinking"] as const) {
		assert.equal(
			types.filter((type) => type === `${kind}_start`).length,
			types.filter((type) => type === `${kind}_end`).length,
			`unbalanced ${kind} blocks`,
		);
	}
	const last = events.at(-1);
	assert.equal(last?.type, "done");
	if (last?.type !== "done") return;
	assert.equal(last.message.stopReason, "stop");
	assert.equal(last.message.usage.totalTokens, 0);
	assert.ok(last.message.content.some((block) => block.type === "thinking" && block.thinking.includes("Considering")));
	const text = messageText(last.message);
	assert.match(text, /⚙️ Executing \[grep for secrets\]/);
	assert.match(text, /✓ grep for secrets: 3 matches\n/);
	assert.doesNotMatch(text, /second line/, "tool output is summarized to its first line");
	assert.match(text, /Hello world #\d+/);
});

test("agents run as separate processes with separate sessions", async () => {
	const handle = makeProvider([fakeAgent(), fakeAgent({ id: "other", name: "Other agent" })]);
	const [fake, other] = handle.provider.getModels();
	assert.ok(fake && other);
	const first = await lastEvent(handle, "one", fake);
	const second = await lastEvent(handle, "two", other);
	assert.ok(first?.type === "done" && second?.type === "done");
	// Each fake process counts its own turns, so both start at #0.
	assert.match(messageText(first.message), /#0/);
	assert.match(messageText(second.message), /#0/);
	assert.equal(second.message.model, "other");
});

test("concurrent Pi sessions using the same ACP agent get independent results", async () => {
	const handle = makeProvider();
	const model = firstModel(handle);
	const run = async (sessionId: string, text: string) =>
		(await collect(handle.provider.streamSimple(model, userContext(`ECHO ${text}`), { sessionId }))).at(-1);
	const [first, second] = await Promise.all([run("session-one", "alpha"), run("session-two", "beta")]);
	assert.equal(first?.type, "done");
	assert.equal(second?.type, "done");
	if (first?.type !== "done" || second?.type !== "done") return;
	assert.equal(messageText(first.message), "alpha");
	assert.equal(messageText(second.message), "beta");
});

test("unidentified calls use isolated, one-turn ACP sessions", async () => {
	const handle = makeProvider();
	const model = firstModel(handle);
	const run = async (text: string) => (await collect(handle.provider.streamSimple(model, userContext(`ECHO ${text}`), {}))).at(-1);
	const [first, second] = await Promise.all([run("alpha"), run("beta")]);
	assert.ok(first?.type === "done" && second?.type === "done");
	assert.equal(messageText(first.message), "alpha");
	assert.equal(messageText(second.message), "beta");
	const again = await lastEvent(handle, "hello");
	assert.ok(again?.type === "done");
	assert.match(messageText(again.message), /#0/);
});

for (const supportsSystemPrompt of [false, true]) {
	test(`directives persist across turns (system prompt support: ${supportsSystemPrompt})`, async () => {
		const handle = makeProvider([fakeAgent({ env: { FAKE_DIRECTIVE: "1", ...(supportsSystemPrompt ? { FAKE_SYSTEM_PROMPT: "1" } : {}) } })]);
		const model = firstModel(handle);
		const payloads: string[] = [];
		const run = async (sessionId: string, directive: string) => {
			const context = normalizeContext({ systemPrompt: directive, messages: [{ role: "user", content: "say hello", timestamp: Date.now() }] });
			return (await collect(handle.provider.streamSimple(model, context, { sessionId, onPayload: (payload) => { payloads.push(JSON.stringify(payload)); } }))).at(-1);
		};
		const first = await run("directive-one", "Start replies with DIRECTIVE-PROBE");
		const followup = await run("directive-one", "Start replies with DIRECTIVE-PROBE");
		const other = await run("directive-two", "No marker");
		assert.ok(first?.type === "done" && followup?.type === "done" && other?.type === "done");
		assert.match(messageText(first.message), /^DIRECTIVE-PROBE/);
		assert.match(messageText(followup.message), /^DIRECTIVE-PROBE/);
		assert.doesNotMatch(messageText(other.message), /DIRECTIVE-PROBE/);
		assert.equal(payloads[0]?.includes("DIRECTIVE-PROBE"), !supportsSystemPrompt);
		assert.equal(payloads[1]?.includes("DIRECTIVE-PROBE"), false);
		const changed = await run("directive-one", "Changed instructions");
		assert.ok(changed?.type === "error");
		assert.match(changed.error.errorMessage ?? "", /instructions changed/);
	});
}

test("overlapping turns in the same Pi session report a conflict", async () => {
	const handle = makeProvider();
	const model = firstModel(handle);
	const run = async (text: string) =>
		(await collect(handle.provider.streamSimple(model, userContext(`ECHO ${text}`), { sessionId: "same" }))).at(-1);
	const outcomes = await Promise.all([run("first"), run("second")]);
	assert.equal(outcomes.filter((outcome) => outcome?.type === "done").length, 1);
	const error = outcomes.find((outcome) => outcome?.type === "error");
	assert.ok(error?.type === "error");
	assert.match(error.error.errorMessage ?? "", /already in flight/);
});

test("session cleanup replaces only the ended session's client", async () => {
	const handle = makeProvider();
	const model = firstModel(handle);
	const run = async (sessionId: string) =>
		(await collect(handle.provider.streamSimple(model, userContext("hello"), { sessionId }))).at(-1);
	const [first, other] = await Promise.all([run("cleanup-one"), run("cleanup-two")]);
	assert.equal(first?.type, "done");
	assert.equal(other?.type, "done");
	cleanupSessionResources("cleanup-one");
	const [restarted, continued] = await Promise.all([run("cleanup-one"), run("cleanup-two")]);
	assert.ok(restarted?.type === "done" && continued?.type === "done");
	assert.match(messageText(restarted.message), /#0/);
	assert.match(messageText(continued.message), /#1/);
});

test("slash command lookup uses the owning Pi session", async () => {
	const handle = makeProvider();
	const model = firstModel(handle);
	const run = async (id: string, name: string) =>
		collect(handle.provider.streamSimple(model, userContext(`COMMAND ${name}`), { sessionId: id }));
	await Promise.all([run("command-one", "alpha"), run("command-two", "beta")]);
	assert.deepEqual((await handle.commands("fake", "command-one")).map((c) => c.name), ["alpha"]);
	assert.deepEqual((await handle.commands("fake", "command-two")).map((c) => c.name), ["beta"]);
});

test("aborting one Pi session does not abort another session", async () => {
	const handle = makeProvider();
	const model = firstModel(handle);
	const controller = new AbortController();
	const first = collect(handle.provider.streamSimple(model, userContext("SLOW first"), { sessionId: "abort-one", signal: controller.signal }));
	const second = collect(handle.provider.streamSimple(model, userContext("ECHO second"), { sessionId: "abort-two" }));
	setTimeout(() => controller.abort(), 100);
	const [aborted, completed] = await Promise.all([first, second]);
	assert.equal(aborted.at(-1)?.type, "error");
	const last = completed.at(-1);
	assert.ok(last?.type === "done");
	assert.equal(messageText(last.message), "second");
});

test("a tool call reported already completed renders its result", async () => {
	const handle = makeProvider();
	const last = await lastEvent(handle, "ONESHOT go");
	assert.ok(last?.type === "done");
	assert.match(messageText(last.message), /⚙️ Executing \[read notes\]\.\.\.\n✓ read notes: 2 notes\n/);
});

test("agentFor resolves bare and agent/model ids to their agent", () => {
	const handle = makeProvider([fakeAgent(), fakeAgent({ id: "other", name: "Other agent" })]);
	assert.equal(handle.agentFor("fake"), "fake");
	assert.equal(handle.agentFor("other/smart"), "other");
	assert.equal(handle.agentFor("ghost/smart"), undefined);
	assert.equal(handle.agentFor("fakeish"), undefined);
});

test("a model id without a configured agent fails cleanly", async () => {
	const handle = makeProvider();
	const last = await lastEvent(handle, "hi", { ...firstModel(handle), id: "ghost" });
	assert.equal(last?.type, "error");
	if (last?.type !== "error") return;
	assert.match(last.error.errorMessage ?? "", /Unknown ACP agent 'ghost'/);
});

test("abort mid-stream finalizes as aborted and the session survives", async () => {
	const handle = makeProvider();
	const model = firstModel(handle);
	const controller = new AbortController();
	const events: AssistantMessageEvent[] = [];
	for await (const event of handle.provider.streamSimple(model, userContext("SLOW abort me"), { signal: controller.signal })) {
		events.push(event);
		if (event.type === "thinking_delta") controller.abort();
	}
	const last = events.at(-1);
	assert.equal(last?.type, "error");
	if (last?.type !== "error") return;
	assert.equal(last.reason, "aborted");
	assert.equal(last.error.stopReason, "aborted");
	assert.equal((await lastEvent(handle, "still here"))?.type, "done");
});

test("process crash surfaces as an error and the next prompt recovers", async () => {
	const handle = makeProvider();
	const last = await lastEvent(handle, "CRASH out");
	assert.equal(last?.type, "error");
	if (last?.type !== "error") return;
	assert.match(last.error.errorMessage ?? "", /Fake agent exited unexpectedly/);
	assert.equal((await lastEvent(handle, "after crash"))?.type, "done");
});

test("auth_required lists the agent's advertised auth methods", async () => {
	const handle = makeProvider();
	const last = await lastEvent(handle, "AUTH please");
	assert.equal(last?.type, "error");
	if (last?.type !== "error") return;
	assert.match(last.error.errorMessage ?? "", /Fake agent requires authentication/);
	assert.match(last.error.errorMessage ?? "", /'fake-login' \(Fake login: Pretend to sign in\)/);
});

test("a configured auth method signs in before the session is created", async () => {
	const handle = makeProvider([fakeAgent({ env: { FAKE_AUTH: "1" }, authMethod: "fake-login" })]);
	assert.equal((await lastEvent(handle, "hello"))?.type, "done");
});

test("RPC errors surface as stream errors", async () => {
	const handle = makeProvider();
	const last = await lastEvent(handle, "RPCERROR go");
	assert.equal(last?.type, "error");
	if (last?.type !== "error") return;
	assert.match(last.error.errorMessage ?? "", /fake rpc failure/);
});

test("a context without a user message fails before start", async () => {
	const handle = makeProvider();
	const events = await collect(handle.provider.streamSimple(firstModel(handle), normalizeContext({ messages: [] }), {}));
	assert.equal(events.length, 1);
	assert.equal(events[0]?.type, "error");
});

test("max_tokens maps to the length stop reason", async () => {
	const handle = makeProvider();
	const last = await lastEvent(handle, "MAXTOKENS hit");
	assert.equal(last?.type, "done");
	if (last?.type !== "done") return;
	assert.equal(last.reason, "length");
});

test("refusal stop reason surfaces as an error", async () => {
	const handle = makeProvider();
	const last = await lastEvent(handle, "REFUSAL please");
	assert.equal(last?.type, "error");
	if (last?.type !== "error") return;
	assert.match(last.error.errorMessage ?? "", /Fake agent refused/);
});

test("instrumentation hooks are honored", async () => {
	const handle = makeProvider();
	const payloads: unknown[] = [];
	const raws: unknown[] = [];
	const events = await collect(
		handle.provider.streamSimple(firstModel(handle), userContext("hook me"), {
			onPayload: (payload) => {
				payloads.push(payload);
				return undefined;
			},
			onProviderStreamEvent: (data) => {
				raws.push(data);
			},
		}),
	);
	assert.equal(events.at(-1)?.type, "done");
	assert.equal(payloads.length, 1);
	assert.match(JSON.stringify(payloads[0]), /"text":"hook me"/);
	assert.ok(raws.length >= 3);
});

test("a rejecting permission policy reaches the agent", async () => {
	const seen: string[] = [];
	const handle = makeProvider([fakeAgent()], {
		permissionPolicy: async (request, { agent }) => {
			seen.push(`${agent.id}:${request.title}`);
			return { outcome: "selected", optionId: "deny" };
		},
	});
	const last = await lastEvent(handle, "PERMISSION ask");
	assert.equal(last?.type, "done");
	if (last?.type !== "done") return;
	assert.match(messageText(last.message), /\[approved=deny\]/);
	assert.deepEqual(seen, ["fake:rm -rf build"]);
});

test("aborting while a permission prompt is open answers it as cancelled", async () => {
	const controller = new AbortController();
	let policySignal: AbortSignal | undefined;
	const handle = makeProvider([fakeAgent()], {
		permissionPolicy: (_request, { signal }) => {
			policySignal = signal;
			controller.abort();
			// An interactive dialog that stays open until dismissed by the signal.
			return new Promise((resolve) =>
				signal?.addEventListener("abort", () => resolve({ outcome: "cancelled" }), { once: true }),
			);
		},
	});
	const events = await collect(
		handle.provider.streamSimple(firstModel(handle), userContext("PERMISSION then abort"), { signal: controller.signal }),
	);
	assert.equal(events.at(-1)?.type, "error");
	assert.ok(policySignal?.aborted);
	assert.equal((await lastEvent(handle, "next turn"))?.type, "done");
});

function modelsAgent(mode: "config" | "legacy"): AcpAgentConfig {
	return fakeAgent({ env: { FAKE_MODELS: mode } });
}

function storeContext(stored?: { models: readonly unknown[] }) {
	let published: { models: readonly unknown[] } | undefined;
	const context = {
		allowNetwork: true,
		signal: new AbortController().signal,
		...(stored ? { stored } : {}),
		publish: async (publication: { persist?: { models: readonly unknown[] } | null; update?: () => void }) => {
			published = publication.persist ?? undefined;
			publication.update?.();
			return true;
		},
	};
	return { context: context as never, persisted: () => published };
}

test("discovery lists the agent's models, grouped options flattened", async () => {
	const handle = makeProvider([modelsAgent("config")]);
	const { context, persisted } = storeContext();
	await handle.provider.refreshModels?.(context);
	const models = handle.provider.getModels();
	assert.deepEqual(
		models.map((model) => [model.id, model.name]),
		[
			["fake", "Fake agent"],
			["fake/fast", "Fast (Fake agent)"],
			["fake/smart", "Smart (Fake agent)"],
		],
	);
	assert.equal(models[1]?.reasoning, true);
	assert.deepEqual(models[1]?.thinkingLevelMap, {
		off: "none",
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: null,
	});
	assert.equal(persisted()?.models.length, 3);
});

test("picking a discovered model and thinking level switches the session", async () => {
	const handle = makeProvider([modelsAgent("config")]);
	await handle.provider.refreshModels?.(storeContext().context);
	const smart = handle.provider.getModels().find((model) => model.id === "fake/smart");
	assert.ok(smart);
	const first = await collect(handle.provider.streamSimple(smart, userContext("hi"), { reasoning: "high" }));
	const done = first.at(-1);
	assert.ok(done?.type === "done");
	assert.match(messageText(done.message), /\[model=smart thought=high\]/);
	// The bare agent model goes back to the agent's default; no reasoning means off.
	const back = await lastEvent(handle, "again", firstModel(handle));
	assert.ok(back?.type === "done");
	assert.match(messageText(back.message), /\[model=fast thought=none\]/);
});

test("each agent's bare model keeps its own session default, even when session ids collide", async () => {
	const handle = makeProvider([
		fakeAgent({ env: { FAKE_MODELS: "config", FAKE_DEFAULT_MODEL: "smart" } }),
		fakeAgent({ id: "other", name: "Other agent", env: { FAKE_MODELS: "config" } }),
	]);
	const [fake, other] = handle.provider.getModels();
	assert.ok(fake && other);
	// Both fake processes name their first session `sess-1`.
	const first = await lastEvent(handle, "hi", fake);
	const second = await lastEvent(handle, "hi", other);
	assert.ok(first?.type === "done" && second?.type === "done");
	assert.match(messageText(first.message), /\[model=smart /);
	assert.match(messageText(second.message), /\[model=fast /);
});

test("legacy models API is discovered and switched with session/set_model", async () => {
	const handle = makeProvider([modelsAgent("legacy")]);
	await handle.provider.refreshModels?.(storeContext().context);
	const ids = handle.provider.getModels().map((model) => model.id);
	assert.deepEqual(ids, ["fake", "fake/fast", "fake/smart"]);
	const smart = handle.provider.getModels()[2];
	assert.ok(smart && !smart.reasoning);
	const last = await lastEvent(handle, "hi", smart);
	assert.ok(last?.type === "done");
	assert.match(messageText(last.message), /\[model=smart/);
});

test("a model the agent does not offer fails with the available list", async () => {
	const handle = makeProvider([modelsAgent("config")]);
	const last = await lastEvent(handle, "hi", { ...firstModel(handle), id: "fake/ghost" });
	assert.ok(last?.type === "error");
	assert.match(last.error.errorMessage ?? "", /does not offer model 'ghost'. Available: fast, smart/);
});

test("stored models are restored without spawning when network is not allowed", async () => {
	const discovered = makeProvider([modelsAgent("config")]);
	const first = storeContext();
	await discovered.provider.refreshModels?.(first.context);
	const stored = first.persisted();
	assert.ok(stored);

	const offline = makeProvider([fakeAgent({ command: "/nonexistent/agent" })]);
	const { context } = storeContext(stored);
	await offline.provider.refreshModels?.({ ...(context as object), allowNetwork: false } as never);
	assert.deepEqual(
		offline.provider.getModels().map((model) => model.id),
		["fake", "fake/fast", "fake/smart"],
	);
	assert.equal(offline.provider.getModels()[1]?.thinkingLevelMap?.high, "high");
});

test("agents without model support list only their default model after discovery", async () => {
	const handle = makeProvider();
	await handle.provider.refreshModels?.(storeContext().context);
	assert.deepEqual(handle.provider.getModels().map((model) => model.id), ["fake"]);
});

test("an agent slash command sent as the prompt returns the agent's output", async () => {
	const handle = makeProvider();
	const last = (await collect(handle.provider.streamSimple(firstModel(handle), userContext("/context"), { sessionId: "command-session" }))).at(-1);
	assert.ok(last?.type === "done");
	assert.equal(messageText(last.message), "context: 42%");
	assert.deepEqual((await handle.commands("fake", "command-session")).map((command) => command.name), ["context", "session"]);
});

test("sessions keep independent cwds across resetSession and non-LIFO disposeSession", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-acp-cwds-"));
	const dirA = join(root, "a");
	const dirB = join(root, "b");
	mkdirSync(dirA);
	mkdirSync(dirB);
	try {
		const handle = makeProvider();
		const model = firstModel(handle);
		handle.resetSession(dirA, "sess-a");
		handle.resetSession(dirB, "sess-b");

		const [resA, resB] = await Promise.all([
			collect(handle.provider.streamSimple(model, userContext("CWD"), { sessionId: "sess-a" })),
			collect(handle.provider.streamSimple(model, userContext("CWD"), { sessionId: "sess-b" })),
		]);
		const lastA = resA.at(-1);
		const lastB = resB.at(-1);
		assert.ok(lastA?.type === "done" && lastB?.type === "done");
		assert.equal(realpathSync(messageText(lastA.message)), realpathSync(dirA));
		assert.equal(realpathSync(messageText(lastB.message)), realpathSync(dirB));

		// Disposing sess-b must not affect sess-a's process or cwd.
		handle.disposeSession("sess-b");
		const followUpA = (await collect(handle.provider.streamSimple(model, userContext("CWD"), { sessionId: "sess-a" }))).at(-1);
		assert.ok(followUpA?.type === "done");
		assert.equal(realpathSync(messageText(followUpA.message)), realpathSync(dirA));
		handle.dispose();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("failed ACP tool_call_update renders failure mark with tracked title", async () => {
	const handle = makeProvider();
	const last = await lastEvent(handle, "FAILED_TOOL");
	assert.ok(last?.type === "done");
	const text = messageText(last.message);
	assert.match(text, /⚙️ Executing \[read secret\.txt\]\.\.\./);
	assert.match(text, /✗ read secret\.txt: ENOENT: no such file/);
	handle.dispose();
});

test("session/resume reconnects without replay and onSessionCreated fires once for new sessions", async () => {
	const created: { piSessionId: string; agentId: string; sessionId: string; instructionsHash: string }[] = [];
	const handle = makeProvider([fakeAgent({ env: { FAKE_RESUME: "1" } })], {
		onSessionCreated: (info) => created.push(info),
	});
	const model = firstModel(handle);
	await collect(handle.provider.streamSimple(model, userContext("ECHO one"), { sessionId: "pi-1" }));
	await collect(handle.provider.streamSimple(model, userContext("ECHO two"), { sessionId: "pi-1" }));
	assert.equal(created.length, 1);

	handle.setResumeSession("pi-resumed", "fake", "saved-acp-sess", created[0]!.instructionsHash);
	const resumed = (await collect(handle.provider.streamSimple(model, userContext("ECHO resumed"), { sessionId: "pi-resumed" }))).at(-1);
	assert.ok(resumed?.type === "done");
	assert.equal(messageText(resumed.message), "resumed");
	assert.equal(created.length, 1, "restoring a session must not emit onSessionCreated");
	handle.dispose();
});

test("session/load restores session and ignores replayed history updates", async () => {
	const handle = makeProvider([fakeAgent({ env: { FAKE_LOAD: "1" } })]);
	const model = firstModel(handle);
	handle.setResumeSession("pi-loaded", "fake", "loaded-acp-sess", fingerprintInstructions(undefined));
	const loaded = (await collect(handle.provider.streamSimple(model, userContext("ECHO after-load"), { sessionId: "pi-loaded" }))).at(-1);
	assert.ok(loaded?.type === "done");
	assert.equal(messageText(loaded.message), "after-load");
	handle.dispose();
});

test("session/resume and session/load resend systemPrompt when supported without warning", async () => {
	for (const envFlag of ["FAKE_RESUME", "FAKE_LOAD"] as const) {
		const warnings: string[] = [];
		const handle = makeProvider(
			[fakeAgent({ env: { [envFlag]: "1", FAKE_SYSTEM_PROMPT: "1", FAKE_DIRECTIVE: "1" } })],
			{ onWarning: (msg) => warnings.push(msg) },
		);
		const model = firstModel(handle);
		const instructions = "Follow DIRECTIVE-PROBE strictly.";
		// Even with a changed fingerprint, systemPrompt-capable agents resend systemPrompt without warning.
		handle.setResumeSession("pi-sys", "fake", "sys-sess", fingerprintInstructions("OLD-DIRECTIVE"));
		const ctx = normalizeContext({ systemPrompt: instructions, messages: [{ role: "user", content: "hello", timestamp: Date.now() }] });
		const last = (await collect(handle.provider.streamSimple(model, ctx, { sessionId: "pi-sys" }))).at(-1);
		assert.ok(last?.type === "done");
		assert.equal(messageText(last.message), "DIRECTIVE-PROBE acknowledged");
		assert.deepEqual(warnings, []);
		handle.dispose();
	}
});

test("resuming with changed or missing instructions warns when systemPrompt is unsupported, or starts fresh if configured", async () => {
	const warnings: string[] = [];
	const created: string[] = [];
	const warnHandle = makeProvider([fakeAgent({ env: { FAKE_RESUME: "1" } })], {
		onWarning: (msg) => warnings.push(msg),
		onSessionCreated: (info) => created.push(info.sessionId),
	});
	const model = firstModel(warnHandle);

	// Changed instructions -> warns and still restores saved session
	warnHandle.setResumeSession("pi-changed", "fake", "saved-1", fingerprintInstructions("DIRECTIVE-A"));
	const changedCtx = normalizeContext({ systemPrompt: "DIRECTIVE-B", messages: [{ role: "user", content: "ECHO kept", timestamp: Date.now() }] });
	const changedRes = (await collect(warnHandle.provider.streamSimple(model, changedCtx, { sessionId: "pi-changed" }))).at(-1);
	assert.ok(changedRes?.type === "done");
	assert.equal(messageText(changedRes.message), "kept");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /instructions changed/);

	// Missing fingerprint -> warns and still restores
	warnHandle.setResumeSession("pi-missing-fp", "fake", "saved-2");
	const missingRes = (await collect(warnHandle.provider.streamSimple(model, userContext("ECHO legacy"), { sessionId: "pi-missing-fp" }))).at(-1);
	assert.ok(missingRes?.type === "done");
	assert.equal(warnings.length, 2);
	assert.match(warnings[1] ?? "", /no instruction fingerprint/);
	assert.equal(created.length, 0);
	warnHandle.dispose();

	// With freshSessionOnInstructionChange: "fresh" -> warns and starts a fresh ACP session with the new directive
	const freshWarnings: string[] = [];
	const freshCreated: string[] = [];
	const freshHandle = makeProvider([fakeAgent({ env: { FAKE_RESUME: "1", FAKE_DIRECTIVE: "1" } })], {
		freshSessionOnInstructionChange: "fresh",
		onWarning: (msg) => freshWarnings.push(msg),
		onSessionCreated: (info) => freshCreated.push(info.sessionId),
	});
	freshHandle.setResumeSession("pi-fresh", "fake", "old-sess", fingerprintInstructions("DIRECTIVE-A"));
	const freshCtx = normalizeContext({ systemPrompt: "DIRECTIVE-PROBE", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
	const freshRes = (await collect(freshHandle.provider.streamSimple(firstModel(freshHandle), freshCtx, { sessionId: "pi-fresh" }))).at(-1);
	assert.ok(freshRes?.type === "done");
	assert.equal(messageText(freshRes.message), "DIRECTIVE-PROBE acknowledged");
	assert.equal(freshWarnings.length, 1);
	assert.match(freshWarnings[0] ?? "", /starting a fresh/);
	assert.equal(freshCreated.length, 1);
	freshHandle.dispose();

	// With freshSessionOnInstructionChange: "restart" -> warns, kills the old agent process, and starts a new one
	const restartWarnings: string[] = [];
	const restartCreated: string[] = [];
	const restartHandle = makeProvider([fakeAgent({ env: { FAKE_RESUME: "1", FAKE_DIRECTIVE: "1" } })], {
		freshSessionOnInstructionChange: "restart",
		onWarning: (msg) => restartWarnings.push(msg),
		onSessionCreated: (info) => restartCreated.push(info.sessionId),
	});
	restartHandle.setResumeSession("pi-restart", "fake", "old-sess", fingerprintInstructions("DIRECTIVE-A"));
	const restartCtx = normalizeContext({ systemPrompt: "DIRECTIVE-PROBE", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
	const restartRes = (await collect(restartHandle.provider.streamSimple(firstModel(restartHandle), restartCtx, { sessionId: "pi-restart" }))).at(-1);
	assert.ok(restartRes?.type === "done");
	assert.equal(messageText(restartRes.message), "DIRECTIVE-PROBE acknowledged");
	assert.equal(restartWarnings.length, 1);
	assert.match(restartWarnings[0] ?? "", /restarting/);
	assert.equal(restartCreated.length, 1);
	restartHandle.dispose();
});

test("onInstructionChange lets the caller choose continue, fresh, restart, or abort", async () => {
	let choice: "continue" | "fresh" | "restart" | "abort" = "fresh";
	const created: string[] = [];
	const handle = makeProvider([fakeAgent({ env: { FAKE_RESUME: "1", FAKE_DIRECTIVE: "1" } })], {
		onSessionCreated: (info) => created.push(info.sessionId),
		onInstructionChange: async () => choice,
	});
	const model = firstModel(handle);
	const ctx = normalizeContext({ systemPrompt: "DIRECTIVE-PROBE", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });

	choice = "fresh";
	handle.setResumeSession("pi-choice-fresh", "fake", "old-1", fingerprintInstructions("OLD"));
	const freshRes = (await collect(handle.provider.streamSimple(model, ctx, { sessionId: "pi-choice-fresh" }))).at(-1);
	assert.ok(freshRes?.type === "done");
	assert.equal(messageText(freshRes.message), "DIRECTIVE-PROBE acknowledged");
	assert.equal(created.length, 1);

	choice = "restart";
	handle.setResumeSession("pi-choice-restart", "fake", "old-2", fingerprintInstructions("OLD"));
	const restartRes = (await collect(handle.provider.streamSimple(model, ctx, { sessionId: "pi-choice-restart" }))).at(-1);
	assert.ok(restartRes?.type === "done");
	assert.equal(messageText(restartRes.message), "DIRECTIVE-PROBE acknowledged");
	assert.equal(created.length, 2);

	choice = "abort";
	handle.setResumeSession("pi-choice-abort", "fake", "old-3", fingerprintInstructions("OLD"));
	const abortRes = (await collect(handle.provider.streamSimple(model, ctx, { sessionId: "pi-choice-abort" }))).at(-1);
	assert.ok(abortRes?.type === "error");
	assert.match(abortRes.error.errorMessage ?? "", /start a new Pi session/);
	handle.dispose();
});

test("resuming an unsupported or missing ACP session surfaces an explicit error", async () => {
	const unsupported = makeProvider();
	unsupported.setResumeSession("pi-unsup", "fake", "sess-1", fingerprintInstructions(undefined));
	const err1 = (await collect(unsupported.provider.streamSimple(firstModel(unsupported), userContext("hi"), { sessionId: "pi-unsup" }))).at(-1);
	assert.ok(err1?.type === "error");
	assert.match(err1.error.errorMessage ?? "", /does not support resuming or loading/);
	unsupported.dispose();

	const missing = makeProvider([fakeAgent({ env: { FAKE_RESUME: "1" } })]);
	missing.setResumeSession("pi-miss", "fake", "missing-session", fingerprintInstructions(undefined));
	const err2 = (await collect(missing.provider.streamSimple(firstModel(missing), userContext("hi"), { sessionId: "pi-miss" }))).at(-1);
	assert.ok(err2?.type === "error");
	assert.match(err2.error.errorMessage ?? "", /Session not found/);
	missing.dispose();
});

test("streamOptions.cwd overrides the session cwd for identified and transient calls", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-acp-stream-cwd-"));
	const dirA = join(root, "a");
	const dirB = join(root, "b");
	mkdirSync(dirA);
	mkdirSync(dirB);
	try {
		const handle = makeProvider();
		const model = firstModel(handle);
		const identified = (
			await collect(handle.provider.streamSimple(model, userContext("CWD"), { sessionId: "sess-cwd", cwd: dirA } as never))
		).at(-1);
		const transient = (
			await collect(handle.provider.streamSimple(model, userContext("CWD"), { cwd: dirB } as never))
		).at(-1);
		assert.ok(identified?.type === "done" && transient?.type === "done");
		assert.equal(realpathSync(messageText(identified.message)), realpathSync(dirA));
		assert.equal(realpathSync(messageText(transient.message)), realpathSync(dirB));
		handle.dispose();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
