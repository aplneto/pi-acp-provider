import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import acpExtension from "../src/index.ts";

type EventHandler = (event: unknown, ctx: unknown) => void;
interface FakeCommand {
	description: string;
	getArgumentCompletions: (prefix: string) => Promise<{ value: string; description: string }[] | null>;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

/** Minimal structural double of the ExtensionAPI surface the extension uses. */
function makeFakePi() {
	const providers: unknown[] = [];
	const handlers = new Map<string, EventHandler>();
	const commands = new Map<string, FakeCommand>();
	const sent: string[] = [];
	const models: unknown[] = [];
	const entries: { customType: string; data: unknown }[] = [];
	const pi = {
		registerProvider: (provider: unknown) => providers.push(provider),
		registerCommand: (name: string, options: FakeCommand) => commands.set(name, options),
		sendUserMessage: (text: string) => sent.push(text),
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		setModel: async (model: unknown) => models.push(model) > 0,
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, handler);
			return () => {};
		},
	};
	return { pi: pi as unknown as ExtensionAPI, providers, handlers, commands, sent, models, entries };
}

/** Runs `fn` with Pi's agent dir pointing at a temp dir holding the given settings.json. */
function withSettings(settings: unknown, fn: () => void | Promise<void>) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-acp-"));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	return Promise.resolve(fn()).finally(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
}

test("agents from settings.json become acp models", () =>
	withSettings(
		{ acp: { agents: { copilot: { command: "copilot", args: ["--acp"] }, gemini: { name: "Gemini", command: "gemini" } } } },
		async () => {
			const { pi, providers, handlers } = makeFakePi();
			acpExtension(pi);
			assert.equal(providers.length, 1);
			const provider = providers[0] as {
				id: string;
				getModels: () => { id: string; name: string }[];
				auth: { apiKey?: { resolve: (input: unknown) => Promise<unknown> } };
			};
			assert.equal(provider.id, "acp");
			assert.deepEqual(
				provider.getModels().map((model) => [model.id, model.name]),
				[
					["copilot", "copilot"],
					["gemini", "Gemini"],
				],
			);
			assert.ok(await provider.auth.apiKey?.resolve({}), "ambient auth must report the provider as configured");

			handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, { cwd: "/tmp", hasUI: false, sessionManager: { getSessionId: () => "session" } });
			handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, undefined);
		},
	));

test("no configured agents warns once at startup", () =>
	withSettings({}, () => {
		const { pi, providers, handlers } = makeFakePi();
		acpExtension(pi);
		assert.deepEqual((providers[0] as { getModels: () => unknown[] }).getModels(), []);
		const notices: string[] = [];
		const ctx = { cwd: "/tmp", hasUI: true, sessionManager: { getSessionId: () => "session" }, ui: { notify: (message: string) => notices.push(message) } };
		handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		handlers.get("session_start")?.({ type: "session_start", reason: "new" }, ctx);
		assert.equal(notices.length, 1);
		assert.match(notices[0] ?? "", /no agents configured/);
		handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, undefined);
	}));

test("each agent gets a command that completes and runs its advertised slash commands", () =>
	withSettings(
		{ acp: { agents: { fake: { command: process.execPath, args: [fileURLToPath(new URL("./fake-agent.mjs", import.meta.url))] } } } },
		async () => {
			const { pi, providers, handlers, commands, sent, models } = makeFakePi();
			acpExtension(pi);
			const command = commands.get("fake");
			assert.ok(command);
			assert.equal(await command.getArgumentCompletions(""), null, "nothing before the agent has started");

			const provider = providers[0] as { refreshModels: (context: unknown) => Promise<void> };
			await provider.refreshModels({
				allowNetwork: true,
				signal: new AbortController().signal,
				publish: async ({ update }: { update?: () => void }) => (update?.(), true),
			});
			// Commands arrive in a notification right after session/new.
			for (let tries = 0; tries < 50 && !(await command.getArgumentCompletions("")); tries++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.deepEqual(await command.getArgumentCompletions("se"), [
				{ value: "session", label: "session", description: "Session tools (info | rename)" },
			]);

			const notes: string[] = [];
			const ctx = { model: undefined, sessionManager: { getSessionId: () => "session" }, ui: { notify: (text: string) => notes.push(text) } };
			await command.handler("", ctx);
			assert.match(notes[0] ?? "", /\/fake context  Show context usage/);
			await command.handler("session info", ctx);
			assert.deepEqual(sent, ["/session info"]);
			assert.equal((models[0] as { id: string }).id, "fake", "switches to the agent first");
			handlers.get("session_shutdown")?.({}, {});
		},
	));

test("session_shutdown with sessionManager disposes only the ended session", () =>
	withSettings(
		{ acp: { agents: { fake: { command: process.execPath, args: [fileURLToPath(new URL("./fake-agent.mjs", import.meta.url))] } } } },
		async () => {
			const { pi, providers, handlers } = makeFakePi();
			acpExtension(pi);
			const provider = providers[0] as {
				getModels: () => { id: string }[];
				streamSimple: (model: unknown, context: unknown, options: unknown) => { result: () => Promise<{ stopReason: string; content: { type: string; text: string }[] }> };
			};
			const root = mkdtempSync(join(tmpdir(), "pi-acp-idx-"));
			const dirA = join(root, "a");
			const dirB = join(root, "b");
			const { mkdirSync, realpathSync, rmSync } = await import("node:fs");
			const { normalizeContext } = await import("@earendil-works/pi-ai/utils/transcript");
			mkdirSync(dirA);
			mkdirSync(dirB);
			try {
				const ctxA = { cwd: dirA, hasUI: false, sessionManager: { getSessionId: () => "sess-a" } };
				const ctxB = { cwd: dirB, hasUI: false, sessionManager: { getSessionId: () => "sess-b" } };
				handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctxA);
				handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctxB);

				const model = provider.getModels()[0];
				const ctx = normalizeContext({ messages: [{ role: "user", content: "CWD", timestamp: Date.now() }] });
				const firstA = await provider.streamSimple(model, ctx, { sessionId: "sess-a" }).result();
				assert.equal(firstA.stopReason, "stop");
				assert.equal(realpathSync(firstA.content.map((b) => b.text).join("")), realpathSync(dirA));

				// Shutting down sess-b must not dispose sess-a.
				handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctxB);
				const secondA = await provider.streamSimple(model, ctx, { sessionId: "sess-a" }).result();
				assert.equal(secondA.stopReason, "stop");
				assert.equal(realpathSync(secondA.content.map((b) => b.text).join("")), realpathSync(dirA));

				handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctxA);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	));

test("interactive and background sessions enforce explicit permissions by default", () =>
	withSettings(
		{ acp: { agents: { fake: { command: process.execPath, args: [fileURLToPath(new URL("./fake-agent.mjs", import.meta.url))] } } } },
		async () => {
			const { pi, providers, handlers } = makeFakePi();
			acpExtension(pi);
			const provider = providers[0] as {
				getModels: () => { id: string }[];
				streamSimple: (model: unknown, context: unknown, options: unknown) => { result: () => Promise<{ stopReason: string; content: { type: string; text: string }[] }> };
			};
			const { normalizeContext } = await import("@earendil-works/pi-ai/utils/transcript");
			const model = provider.getModels()[0];
			const prompt = normalizeContext({ messages: [{ role: "user", content: "PERMISSION", timestamp: Date.now() }] });

			const prompts: string[] = [];
			const interactiveCtx = {
				cwd: "/tmp",
				hasUI: true,
				sessionManager: { getSessionId: () => "interactive-perm" },
				ui: {
					notify: () => {},
					select: async (title: string) => {
						prompts.push(title);
						return "Allow";
					},
				},
			};
			const backgroundCtx = {
				cwd: "/tmp",
				hasUI: false,
				sessionManager: { getSessionId: () => "background-perm" },
			};
			handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, interactiveCtx);
			handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, backgroundCtx);

			const [interactiveRes, backgroundRes] = await Promise.all([
				provider.streamSimple(model, prompt, { sessionId: "interactive-perm" }).result(),
				provider.streamSimple(model, prompt, { sessionId: "background-perm" }).result(),
			]);
			assert.equal(prompts.length, 1);
			assert.match(prompts[0] ?? "", /fake permission: rm -rf build/);
			assert.match(interactiveRes.content.map((b) => b.text).join(""), /\[approved=allow\]/);
			assert.match(backgroundRes.content.map((b) => b.text).join(""), /\[approved=deny\]/);

			handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, interactiveCtx);
			handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, backgroundCtx);
		},
	));

test("background restore rejects changed or unverifiable instructions by default", () =>
	withSettings(
		{ acp: { agents: { fake: { command: process.execPath, args: [fileURLToPath(new URL("./fake-agent.mjs", import.meta.url))], env: { FAKE_RESUME: "1" } } } } },
		async () => {
			const { pi, providers, handlers } = makeFakePi();
			acpExtension(pi);
			const provider = providers[0] as {
				getModels: () => { id: string }[];
				streamSimple: (model: unknown, context: unknown, options: unknown) => { result: () => Promise<{ stopReason: string; errorMessage?: string }> };
			};
			const { normalizeContext } = await import("@earendil-works/pi-ai/utils/transcript");
			const { fingerprintInstructions } = await import("../src/provider.ts");
			const prompt = normalizeContext({ systemPrompt: "new instructions", messages: [{ role: "user", content: "ECHO hello", timestamp: Date.now() }] });
			for (const [id, hash, reason] of [
				["changed", fingerprintInstructions("old instructions"), /instructions changed/],
				["missing", undefined, /no instruction fingerprint/],
			] as const) {
				const ctx = {
					cwd: "/tmp", hasUI: false,
					sessionManager: {
						getSessionId: () => id,
						getBranch: () => [{ type: "custom", customType: "acp-session", data: { agentId: "fake", sessionId: "saved", cwd: "/tmp", instructionsHash: hash } }],
					},
				};
				handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, ctx);
				const result = await provider.streamSimple(provider.getModels()[0], prompt, { sessionId: id }).result();
				assert.equal(result.stopReason, "error");
				assert.match(result.errorMessage ?? "", reason);
				assert.match(result.errorMessage ?? "", /Start a new Pi session/);
				handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, ctx);
			}
		},
	));

test("extension persists acp-session entries and restores on resume", () =>
	withSettings(
		{ acp: { agents: { fake: { command: process.execPath, args: [fileURLToPath(new URL("./fake-agent.mjs", import.meta.url))], env: { FAKE_RESUME: "1" } } } } },
		async () => {
			const { pi, providers, handlers, entries } = makeFakePi();
			acpExtension(pi);
			const provider = providers[0] as {
				getModels: () => { id: string }[];
				streamSimple: (model: unknown, context: unknown, options: unknown) => { result: () => Promise<{ stopReason: string; content: { type: string; text: string }[] }> };
			};
			const { normalizeContext } = await import("@earendil-works/pi-ai/utils/transcript");
			const model = provider.getModels()[0];
			const startCtx = { cwd: "/tmp", hasUI: false, sessionManager: { getSessionId: () => "pi-s1", getBranch: () => [] } };
			handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, startCtx);
			await provider.streamSimple(
				model,
				normalizeContext({ systemPrompt: "SECRET-PROMPT", messages: [{ role: "user", content: "ECHO first", timestamp: Date.now() }] }),
				{ sessionId: "pi-s1" },
			).result();
			assert.equal(entries.length, 1);
			assert.equal(entries[0]?.customType, "acp-session");
			const saved = entries[0]?.data as { instructionsHash?: string };
			assert.equal(typeof saved.instructionsHash, "string");
			assert.ok(!JSON.stringify(saved).includes("SECRET-PROMPT"), "raw instructions must not be persisted");

			const resumeCtx = {
				cwd: "/tmp",
				hasUI: false,
				sessionManager: {
					getSessionId: () => "pi-s2",
					getBranch: () => [{ type: "custom", customType: entries[0]!.customType, data: entries[0]!.data }],
				},
			};
			handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, resumeCtx);
			const resumed = await provider.streamSimple(
				model,
				normalizeContext({ systemPrompt: "SECRET-PROMPT", messages: [{ role: "user", content: "ECHO second", timestamp: Date.now() }] }),
				{ sessionId: "pi-s2" },
			).result();
			assert.equal(resumed.stopReason, "stop");
			assert.equal(resumed.content.map((b) => b.text).join(""), "second");
			assert.equal(entries.length, 1, "resumed session does not append a duplicate acp-session entry");

			const legacyWarnings: { msg: string; level: string }[] = [];
			let selectCalls = 0;
			const legacyCtx = {
				cwd: "/tmp",
				hasUI: true,
				ui: {
					notify: (msg: string, level: string) => legacyWarnings.push({ msg, level }),
					select: async () => {
						selectCalls++;
						return "Continue existing session (keep prior instructions)";
					},
				},
				sessionManager: {
					getSessionId: () => "pi-legacy",
					getBranch: () => [{ type: "custom", customType: "acp-session", data: { agentId: "fake", sessionId: "old-sess", cwd: "/tmp" } }],
				},
			};
			handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, legacyCtx);
			const legacyRes = await provider.streamSimple(
				model,
				normalizeContext({ messages: [{ role: "user", content: "ECHO legacy", timestamp: Date.now() }] }),
				{ sessionId: "pi-legacy" },
			).result();
			assert.equal(legacyRes.stopReason, "stop");
			assert.equal(legacyWarnings.length, 1);
			assert.equal(legacyWarnings[0]?.level, "warning");
			assert.equal(selectCalls, 1);

			handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, startCtx);
			handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, resumeCtx);
			handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, legacyCtx);
		},
	));
