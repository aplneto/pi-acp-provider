/**
 * Configuration for the ACP provider extension.
 *
 * Agents are declared under `acp.agents` in Pi's `settings.json`
 * (`~/.pi/agent/` by default); each becomes the model `acp/<id>`.
 * Environment variables override the global options.
 */

import { readFileSync } from "node:fs";
import { isRecord } from "./acp.ts";

/** One ACP agent: a command that speaks ACP over stdio. */
export interface AcpAgentConfig {
	/** Model id: selected with `/model acp/<id>`. */
	id: string;
	/** Display name in the model picker and error messages. */
	name: string;
	command: string;
	args: string[];
	env: Record<string, string>;
	/** `authenticate` method to use when the agent reports `auth_required`. */
	authMethod: string | undefined;
}

export type InstructionChangeMode = "ask" | "continue" | "fresh" | "restart";

export interface AcpProviderConfig {
	agents: AcpAgentConfig[];
	autoApproveTools: boolean;
	/** How to handle changed/missing instructions on restore when an agent lacks `systemPrompt` support. */
	freshSessionOnInstructionChange: InstructionChangeMode;
	/** Bounds `initialize`, `session/new`, and session setting changes. */
	handshakeTimeoutMs: number;
	/** Wire diagnostics on stderr (`ACP_DEBUG`). */
	debug: boolean;
}

export type AcpAgentSettings = Partial<Omit<AcpAgentConfig, "id" | "command">> & { command: string };

/** The `acp` settings object. */
export type AcpSettings = Partial<{
	agents: Record<string, AcpAgentSettings>;
	autoApproveTools: boolean;
	freshSessionOnInstructionChange: InstructionChangeMode | boolean;
	handshakeTimeoutMs: number;
}>;

const DEFAULTS = {
	autoApproveTools: false,
	freshSessionOnInstructionChange: "ask",
	handshakeTimeoutMs: 30_000,
} as const;

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

function parseStringRecord(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const entries = Object.entries(value);
	const strings = entries.filter((entry): entry is [string, string] => typeof entry[1] === "string");
	return strings.length === entries.length ? Object.fromEntries(strings) : undefined;
}

function parseAgent(value: unknown): AcpAgentSettings | undefined {
	if (!isRecord(value) || typeof value.command !== "string" || !value.command) return undefined;
	const agent: AcpAgentSettings = { command: value.command };
	if (typeof value.name === "string" && value.name) agent.name = value.name;
	if (isStringArray(value.args)) agent.args = value.args;
	const env = parseStringRecord(value.env);
	if (env) agent.env = env;
	if (typeof value.authMethod === "string" && value.authMethod) agent.authMethod = value.authMethod;
	return agent;
}

/** Keeps only well-typed keys; invalid agents and values are dropped. */
export function parseSettings(value: unknown): AcpSettings {
	if (!isRecord(value)) return {};
	const settings: AcpSettings = {};
	if (isRecord(value.agents)) {
		const agents = Object.entries(value.agents).flatMap(([id, raw]): [string, AcpAgentSettings][] => {
			const agent = parseAgent(raw);
			return id && agent ? [[id, agent]] : [];
		});
		settings.agents = Object.fromEntries(agents);
	}
	if (typeof value.autoApproveTools === "boolean") settings.autoApproveTools = value.autoApproveTools;
	const mode = value.freshSessionOnInstructionChange;
	if (
		typeof mode === "boolean" ||
		mode === "ask" ||
		mode === "continue" ||
		mode === "fresh" ||
		mode === "restart"
	) {
		settings.freshSessionOnInstructionChange = mode;
	}
	const timeout = value.handshakeTimeoutMs;
	if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0) settings.handshakeTimeoutMs = timeout;
	return settings;
}

/** Reads `acp` from a settings.json file; a missing or malformed file yields {}. */
export function loadSettings(path: string): AcpSettings {
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
	return parseSettings(isRecord(json) ? json.acp : undefined);
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
	switch (value?.toLowerCase()) {
		case "1":
		case "true":
			return true;
		case "0":
		case "false":
			return false;
		default:
			return undefined;
	}
}

function resolveInstructionChangeMode(value: InstructionChangeMode | boolean | undefined): InstructionChangeMode {
	if (value === true) return "fresh";
	if (value === false || value === undefined) return DEFAULTS.freshSessionOnInstructionChange;
	return value;
}

export function resolveConfig({
	settings,
	env,
}: {
	settings: AcpSettings;
	env: Record<string, string | undefined>;
}): AcpProviderConfig {
	return {
		agents: Object.entries(settings.agents ?? {}).map(([id, agent]) => ({
			id,
			name: agent.name ?? id,
			command: agent.command,
			args: agent.args ?? [],
			env: agent.env ?? {},
			authMethod: agent.authMethod,
		})),
		autoApproveTools:
			parseBooleanFlag(env.ACP_AUTO_APPROVE) ?? settings.autoApproveTools ?? DEFAULTS.autoApproveTools,
		freshSessionOnInstructionChange: resolveInstructionChangeMode(settings.freshSessionOnInstructionChange),
		handshakeTimeoutMs: settings.handshakeTimeoutMs ?? DEFAULTS.handshakeTimeoutMs,
		debug: parseBooleanFlag(env.ACP_DEBUG) ?? false,
	};
}
