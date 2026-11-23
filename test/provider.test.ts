import test from "node:test";
import assert from "node:assert/strict";
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
import { createAcpProvider, type AcpProviderOptions, type AcpProviderHandle } from "../src/provider.ts";
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
	extra: Omit<AcpProviderOptions, "config"> = {},
): AcpProviderHandle {
	const handle = createAcpProvider({ config: { agents, autoApproveTools: true, handshakeTimeoutMs: 8000, debug: false }, ...extra });
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
