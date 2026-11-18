/** Claude transcript messages mapped to the dock's display entries (pure, bundled into the bridge). */
/** Fields a tool call may name as its subject; anything else in its input stays in Claude Code. */
const TOOL_SUBJECTS = ["file_path", "path", "pattern", "command", "url", "description"] as const;

/**
 * One transcript message → display entries: its text, plus one short line per tool call
 * (tool name and its subject, truncated). Tool results and other content are not exported.
 */
/** Machine-generated user turns: the SDK marks them with an `origin` (untyped in its .d.ts). */
function automaticOrigin(origin: unknown): string | null {
	const kind = (origin as { kind?: unknown } | null)?.kind;
	return kind === "task-notification" ? kind : null;
}

function plainText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p: { type?: string }) => p?.type === "text")
		.map((p: { text?: string }) => p.text ?? "")
		.join("\n");
}

/**
 * A background task's notification is not something the user wrote: it becomes one compact
 * technical line with its status (a short word) only. Its report, ids and producer stay out.
 */
function taskNotification(content: unknown): { role: "tool"; text: string } {
	const status = /<status>\s*([a-z][a-z _-]{0,30}?)\s*<\/status>/i.exec(plainText(content))?.[1];
	return { role: "tool", text: status ? `Task notification · ${status.toLowerCase()}` : "Task notification" };
}

export function conversationEntries(m: {
	type: string;
	message: unknown;
	origin?: unknown;
}): { role: "user" | "agent" | "tool"; text: string }[] {
	const content = (m.message as { content?: unknown })?.content;
	if (m.type === "user" && automaticOrigin(m.origin)) return [taskNotification(content)];
	const role = m.type === "user" ? "user" : "agent";
	if (typeof content === "string") return [{ role, text: content }];
	if (!Array.isArray(content)) return [];
	const entries: { role: "user" | "agent" | "tool"; text: string }[] = [];
	const body = content
		.filter((p: { type?: string }) => p?.type === "text")
		.map((p: { text?: string }) => p.text ?? "")
		.join("\n");
	if (body.trim()) entries.push({ role, text: body });
	for (const part of content as { type?: string; name?: unknown; input?: unknown }[]) {
		if (part?.type !== "tool_use" || typeof part.name !== "string") continue;
		const input = (part.input ?? {}) as Record<string, unknown>;
		const subject = TOOL_SUBJECTS.map((field) => input[field]).find((value) => typeof value === "string");
		const label = subject ? `${part.name} · ${String(subject).replace(/\s+/g, " ")}` : part.name;
		entries.push({ role: "tool", text: label.slice(0, 300) });
	}
	return entries;
}
