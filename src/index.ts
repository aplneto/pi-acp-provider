/**
 * Pi extension entry point: registers the `acp` provider.
 *
 * Every agent configured under `acp.agents` in Pi's `settings.json` becomes a
 * model, selected with `/model acp/<agent id>`. Each agent process is
 * spawned lazily on its first prompt, kept alive across prompts, and killed on
 * session shutdown so no orphans remain.
 */

import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { autoReject } from "./acp.ts";
import { loadSettings, resolveConfig } from "./config.ts";
import { ACP_PROVIDER_ID, createAcpProvider, type PermissionPolicy } from "./provider.ts";

type SessionUi = Pick<ExtensionUIContext, "select" | "notify">;

/** Asks the user via a select dialog; denies when no dialog-capable UI exists. */
function interactivePolicy(getUi: (sessionId?: string) => SessionUi | undefined): PermissionPolicy {
	return async (request, { agent, signal, sessionId }) => {
		const ui = getUi(sessionId);
		if (!ui) return autoReject(request);
		const chosen = await ui.select(
			`${agent.name} permission: ${request.title}`,
			request.options.map((option) => option.name),
			signal ? { signal } : undefined,
		);
		const option = request.options.find((candidate) => candidate.name === chosen);
		return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
	};
}

export default function acpExtension(pi: ExtensionAPI): void {
	const settingsPath = join(getAgentDir(), "settings.json");
	const config = resolveConfig({ settings: loadSettings(settingsPath), env: process.env });
	const log = config.debug ? (message: string) => process.stderr.write(`[acp] ${message}\n`) : undefined;

	const sessionUis = new Map<string, SessionUi>();
	let currentSessionId: string | undefined;
	const handle = createAcpProvider({
		config,
		log,
		onSessionCreated: ({ agentId, sessionId, cwd, instructionsHash }) => {
			pi.appendEntry("acp-session", { agentId, sessionId, cwd, instructionsHash });
		},
		onWarning: (message, sessionId) => {
			sessionUis.get(sessionId ?? currentSessionId ?? "")?.notify(message, "warning");
		},
		onInstructionChange: async ({ agent, message, signal, piSessionId }) => {
			const ui = sessionUis.get(piSessionId ?? currentSessionId ?? "");
			if (!ui) return "continue";
			ui.notify(message, "warning");
			const continueChoice = "Continue existing session (keep prior instructions)";
			const freshChoice = "Start a fresh ACP session (apply new instructions)";
			const abortChoice = "Cancel (start a new Pi session instead)";
			const chosen = await ui.select(
				`${agent.name} instructions changed on restore`,
				[continueChoice, freshChoice, abortChoice],
				signal ? { signal } : undefined,
			);
			if (chosen === freshChoice) return "fresh";
			if (chosen === continueChoice) return "continue";
			return "abort";
		},
		...(config.autoApproveTools
			? {}
			: { permissionPolicy: interactivePolicy((sessionId) => sessionUis.get(sessionId ?? currentSessionId ?? "")) }),
	});
	pi.registerProvider(handle.provider);

	// `/<agent id> <command>` runs a slash command the agent advertised
	// (e.g. Copilot's `/context`) by sending it to the agent as the prompt.
	for (const agent of config.agents) {
		pi.registerCommand(agent.id, {
			description: `Run a ${agent.name} slash command`,
			getArgumentCompletions: async (prefix) => {
				const items = (await handle.commands(agent.id, currentSessionId))
					.filter((command) => command.name.startsWith(prefix.trim()))
					.map((command) => ({
						value: command.name,
						label: command.name,
						description: [command.description, command.hint && `(${command.hint})`].filter(Boolean).join(" "),
					}));
				return items.length > 0 ? items : null;
			},
			handler: async (args, ctx) => {
				if (!args.trim()) {
					const commands = await handle.commands(agent.id, ctx.sessionManager.getSessionId());
					const list = commands.map((command) => `/${agent.id} ${command.name}  ${command.description}`).join("\n");
					ctx.ui.notify(list || `${agent.name} has not advertised any commands yet.`, "info");
					return;
				}
				// Commands go to the agent, so make sure one of its models is active.
				const current = ctx.model;
				const onAgent = current?.provider === ACP_PROVIDER_ID && handle.agentFor(current.id) === agent.id;
				if (!onAgent) {
					const model = handle.provider.getModels().find((candidate) => candidate.id === agent.id);
					if (!model || !(await pi.setModel(model))) {
						ctx.ui.notify(`Could not switch to ${agent.name}.`, "error");
						return;
					}
				}
				pi.sendUserMessage(`/${args.trim()}`);
			},
		});
	}

	pi.on("session_start", (event, ctx) => {
		// A new Pi session (`/new`, `/resume`, `/fork`) gets new ACP sessions.
		const sessionId = ctx.sessionManager.getSessionId();
		currentSessionId = sessionId;
		handle.resetSession(ctx.cwd, sessionId);
		if (event.reason === "startup" || event.reason === "resume") {
			const branch = (ctx.sessionManager as { getBranch?: () => unknown[] }).getBranch?.() ?? [];
			for (const entry of branch) {
				if (
					typeof entry === "object" &&
					entry !== null &&
					(entry as { type?: unknown }).type === "custom" &&
					(entry as { customType?: unknown }).customType === "acp-session"
				) {
					const data = (entry as { data?: { agentId?: unknown; sessionId?: unknown; cwd?: unknown; instructionsHash?: unknown } }).data;
					if (
						typeof data?.agentId === "string" &&
						typeof data.sessionId === "string" &&
						(data.cwd === undefined || data.cwd === ctx.cwd)
					) {
						handle.setResumeSession(
							sessionId,
							data.agentId,
							data.sessionId,
							typeof data.instructionsHash === "string" ? data.instructionsHash : undefined,
						);
					}
				}
			}
		}
		if (ctx.hasUI) sessionUis.set(sessionId, ctx.ui);
		else sessionUis.delete(sessionId);
		if (event.reason === "startup" && config.agents.length === 0 && ctx.hasUI) {
			ctx.ui.notify(`ACP provider: no agents configured. Add "acp.agents" to ${settingsPath}.`, "warning");
		}
	});
	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = ctx?.sessionManager?.getSessionId?.();
		if (sessionId) {
			sessionUis.delete(sessionId);
			if (currentSessionId === sessionId) currentSessionId = undefined;
			handle.disposeSession(sessionId);
			return;
		}
		sessionUis.clear();
		currentSessionId = undefined;
		handle.dispose();
	});
}
