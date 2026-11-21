import { describe, expect, it } from "vitest";
import { conversationEntries } from "./claude-transcript";

describe("Claude transcript entries", () => {
	it("keeps text and turns each tool call into one short line, never its full input or result", () => {
		const entries = conversationEntries({
			type: "assistant",
			message: {
				content: [
					{ type: "text", text: "Je lis le fichier." },
					{ type: "tool_use", name: "Read", input: { file_path: "/p/plan-card.tsx", secret: "x" } },
					{ type: "tool_use", name: "Bash", input: { command: "bun   test\n--watch", env: "TOKEN=1" } },
					{ type: "tool_use", name: "TodoWrite", input: { todos: [] } },
				],
			},
		});
		expect(entries).toEqual([
			{ role: "agent", text: "Je lis le fichier." },
			{ role: "tool", text: "Read · /p/plan-card.tsx" },
			{ role: "tool", text: "Bash · bun test --watch" },
			{ role: "tool", text: "TodoWrite" },
		]);
		expect(JSON.stringify(entries)).not.toContain("TOKEN");
	});

	it("drops tool results and empty user messages, keeps plain string content", () => {
		expect(
			conversationEntries({
				type: "user",
				message: { content: [{ type: "tool_result", content: "secret output" }] },
			}),
		).toEqual([]);
		expect(conversationEntries({ type: "user", message: { content: "Bonjour" } })).toEqual([
			{ role: "user", text: "Bonjour" },
		]);
		const long = conversationEntries({
			type: "assistant",
			message: { content: [{ type: "tool_use", name: "Bash", input: { command: "x".repeat(900) } }] },
		});
		expect(long[0]?.text.length).toBe(300);
	});

	it("shows a task notification as one technical line from its structured origin, never as the user", () => {
		const report = [
			"<task-notification>",
			"<task-id>a1b2c3</task-id>",
			"<status>completed</status>",
			'<summary>Agent "review" completed</summary>',
			"<result>## Report\n```ts\nconst secret = 1;\n```\n42 files, 3 findings</result>",
			"</task-notification>",
		].join("\n");
		const entries = conversationEntries({
			type: "user",
			origin: { kind: "task-notification", producer: "session-task" },
			message: { content: report },
		});
		expect(entries).toEqual([{ role: "tool", text: "Task notification · completed" }]);
		expect(JSON.stringify(entries)).not.toMatch(/a1b2c3|session-task|secret|Report/);
		// Same text typed by a person (no structured origin) stays a user message.
		expect(conversationEntries({ type: "user", message: { content: report } })).toEqual([
			{ role: "user", text: report },
		]);
		// An unsafe status is not echoed.
		expect(
			conversationEntries({
				type: "user",
				origin: { kind: "task-notification" },
				message: { content: [{ type: "text", text: "<status>done; rm -rf /</status>" }] },
			}),
		).toEqual([{ role: "tool", text: "Task notification" }]);
	});
});
