/**
 * Local transcript helpers matching `@earendil-works/pi-ai/utils/transcript`.
 *
 * Pi's extension loader aliases `@earendil-works/pi-ai` to its `compat`
 * entrypoint and does not expose subpath exports like `/utils/transcript` when
 * an extension is installed via `pi install git:...` without `node_modules`.
 */
import type { Message, SystemMessage, Tool } from "@earendil-works/pi-ai";

function contentText(content: SystemMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Resolves the tools available after applying every system-message delta in order. */
export function getCurrentTools(messages: readonly Message[]): Tool[] {
	const tools = new Map<string, Tool>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	return [...tools.values()];
}

/** Renders the current system prompt text after replaying every system message. */
export function getCurrentSystemPrompt(messages: readonly Message[]): string {
	const content: string[] = [];
	const sections = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		const text = contentText(message.content);
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
	}
	const parts = [content.join("\n\n"), ...sections.values()];
	return parts.filter((part) => part.length > 0).join("\n\n");
}

/** Strips executable and display-only fields from a tool before serialization. */
export function toToolDeclaration(tool: Tool): Tool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: JSON.parse(JSON.stringify(tool.parameters)) as Tool["parameters"],
		...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
	};
}
