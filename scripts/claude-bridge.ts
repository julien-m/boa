/**
 * BOA ↔ Claude Code bridge: a long-lived child of the BOA app speaking NDJSON on stdio.
 *
 * It only calls the official `@anthropic-ai/claude-agent-sdk` APIs (listSessions,
 * getSessionInfo, getSessionMessages, renameSession, query). It never edits transcripts.
 * Sessions it drives through `query()` are owned by BOA: one streaming input per session,
 * user messages stamped as human input, permission prompts relayed to BOA for a decision.
 *
 * Requests:  {"id": n, "op": "...", ...}
 * Responses: {"id": n, "ok": true, "result": ...} | {"id": n, "ok": false, "error": {code, message}}
 * Events:    {"event": "...", "sessionId": "...", ...} (no id)
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
	getSessionInfo,
	getSessionMessages,
	listSessions,
	type PermissionResult,
	query,
	renameSession,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { conversationEntries } from "./claude-transcript";

type Request = { id: number; op: string; [key: string]: unknown };
type BridgeError = { code: string; message: string };

const MAX_LIMIT = 200;
/**
 * Per-message acknowledgement deadline. A cold start loads the user's hooks, plugins and MCP
 * servers before Claude Code accepts input (≈42 s observed); 120 s leaves margin, and a later
 * acknowledgement is reported as an unknown result, never retried.
 */
const ACK_TIMEOUT_MS = 120_000;
/** A pending permission prompt blocks the agent; 30 min mirrors an unattended terminal prompt. */
const PERMISSION_TIMEOUT_MS = 30 * 60 * 1000;
const CLAUDE_BIN = process.env.BOA_CLAUDE_BIN;

function emit(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fail(code: string, message: string): never {
	throw { code, message } satisfies BridgeError;
}

function text(value: unknown, field: string, max: number): string {
	if (typeof value !== "string" || value.trim() === "" || value.length > max)
		fail("invalid_input", `${field}: expected 1-${max} characters`);
	return value;
}

function limit(value: unknown): number {
	const n = typeof value === "number" && Number.isInteger(value) ? value : 50;
	return Math.max(1, Math.min(MAX_LIMIT, n));
}

/** Streaming input owned by BOA for one Claude session. */
class OwnedSession {
	private readonly pending: SDKUserMessage[] = [];
	private wake: (() => void) | null = null;
	private closed = false;
	state: "working" | "awaitingInput" | "idle" = "working";
	sessionId: string | null;
	private readonly permissions = new Map<string, (allow: boolean) => void>();
	private readonly ready: Promise<string>;
	private resolveReady!: (id: string) => void;
	private rejectReady!: (error: BridgeError) => void;

	constructor(
		readonly cwd: string,
		resume: string | null,
	) {
		this.sessionId = resume;
		this.ready = new Promise((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});
		// Register the session and its first acknowledgement before the SDK can fail synchronously.
		queueMicrotask(() => void this.run(resume));
	}

	private readonly acks = new Map<string, { resolve: () => void; reject: (error: BridgeError) => void }>();

	/**
	 * Queues one human message with its own uuid and resolves when Claude Code acknowledges
	 * that exact message (replayed user message with the same uuid, `--replay-user-messages`).
	 * Rejects with `result_unknown` if no acknowledgement arrives in time.
	 */
	push(content: string): Promise<string> {
		const uuid = randomUUID();
		const acknowledged = new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.acks.delete(uuid);
				reject({ code: "result_unknown", message: "no acknowledgement from Claude Code in time" });
			}, ACK_TIMEOUT_MS);
			this.acks.set(uuid, {
				resolve: () => {
					clearTimeout(timer);
					resolve(uuid);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
		});
		this.pending.push({
			type: "user",
			uuid,
			message: { role: "user", content },
			parent_tool_use_id: null,
			session_id: this.sessionId ?? "",
			origin: { kind: "human" },
		} as SDKUserMessage);
		this.state = "working";
		this.wake?.();
		return acknowledged;
	}

	whenReady(): Promise<string> {
		return this.ready;
	}

	answerPermission(requestId: string, allow: boolean): boolean {
		const resolve = this.permissions.get(requestId);
		if (!resolve) return false;
		this.permissions.delete(requestId);
		emit({ event: "permissionResolved", sessionId: this.sessionId, requestId });
		resolve(allow);
		return true;
	}

	close(): void {
		this.closed = true;
		this.wake?.();
	}

	private async *input(): AsyncGenerator<SDKUserMessage> {
		while (!this.closed) {
			const next = this.pending.shift();
			if (next) {
				yield next;
				continue;
			}
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
			this.wake = null;
		}
	}

	private async run(resume: string | null): Promise<void> {
		try {
			const stream = query({
				prompt: this.input(),
				options: {
					cwd: this.cwd,
					...(resume ? { resume } : {}),
					...(CLAUDE_BIN ? { pathToClaudeCodeExecutable: CLAUDE_BIN } : {}),
					canUseTool: (toolName, input) => this.askPermission(toolName, input),
					// Documented CLI flag: echo each accepted user message (same uuid) as its receipt.
					extraArgs: { "replay-user-messages": null },
				},
			});
			for await (const message of stream) this.observe(message);
		} catch (error) {
			this.rejectReady({ code: "claude_failed", message: String(error).slice(0, 300) });
			// Before Claude Code ran this session nothing was transmitted: a clean failure.
			// Afterwards, an unacknowledged message may or may not have been taken: unknown.
			const failure: BridgeError = this.started
				? { code: "result_unknown", message: "Claude Code stopped before acknowledging" }
				: { code: "claude_failed", message: String(error).slice(0, 300) };
			for (const ack of this.acks.values()) ack.reject(failure);
			this.acks.clear();
			emit({ event: "sessionError", sessionId: this.sessionId, code: "claude_failed" });
		} finally {
			this.state = "idle";
			if (this.sessionId) {
				owned.delete(this.sessionId);
				emit({ event: "sessionClosed", sessionId: this.sessionId });
			}
		}
	}

	private started = false;

	private observe(message: SDKMessage): void {
		if (message.session_id && !this.sessionId) this.sessionId = message.session_id;
		// The first message carrying the session id proves Claude Code runs this session and
		// consumed our input stream. `init` can come 40 s later on a cold start (user hooks,
		// plugins, MCP servers), so it is not used as the acknowledgement.
		if (!this.started && message.session_id && this.sessionId) {
			this.started = true;
			owned.set(this.sessionId, this);
			this.resolveReady(this.sessionId);
			emit({ event: "sessionStarted", sessionId: this.sessionId });
		}
		if (message.type === "user" && "isReplay" in message && message.isReplay && message.uuid) {
			this.acks.get(message.uuid)?.resolve();
			this.acks.delete(message.uuid);
		}
		if (message.type === "assistant") {
			const parts = (message.message.content ?? []) as Array<{ type: string; text?: string }>;
			const body = parts
				.filter((part) => part.type === "text" && part.text)
				.map((part) => part.text)
				.join("\n");
			if (body) emit({ event: "agentMessage", sessionId: this.sessionId, text: body });
		}
		if (message.type === "result") {
			this.state = this.pending.length > 0 ? "working" : "idle";
			emit({
				event: "turnCompleted",
				sessionId: this.sessionId,
				outcome: message.subtype,
			});
		}
	}

	private askPermission(toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
		const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		this.state = "awaitingInput";
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (this.permissions.delete(requestId)) {
					emit({ event: "permissionResolved", sessionId: this.sessionId, requestId });
					resolve({ behavior: "deny", message: "No decision from BOA in time" });
				}
			}, PERMISSION_TIMEOUT_MS);
			this.permissions.set(requestId, (allow) => {
				clearTimeout(timer);
				this.state = "working";
				resolve(
					allow
						? { behavior: "allow", updatedInput: input }
						: { behavior: "deny", message: "Denied from BOA" },
				);
			});
			// Publish only after an explicit answer can reach the registered request.
			emit({
				event: "permissionRequest",
				sessionId: this.sessionId,
				requestId,
				toolName,
				// Only a short summary leaves the bridge; full tool input stays in Claude Code.
				summary: JSON.stringify(input).slice(0, 300),
			});
		});
	}
}

const owned = new Map<string, OwnedSession>();

async function handle(request: Request): Promise<unknown> {
	switch (request.op) {
		case "list": {
			const dirs = Array.isArray(request.dirs) ? request.dirs.filter((d) => typeof d === "string") : [];
			const max = limit(request.limit);
			const pages = await Promise.all(dirs.map((dir) => listSessions({ dir, limit: max })));
			return pages
				.flat()
				.sort((a, b) => b.lastModified - a.lastModified)
				.slice(0, max)
				.map((s) => ({
					sessionId: s.sessionId,
					title: s.customTitle ?? s.summary,
					cwd: s.cwd ?? null,
					gitBranch: s.gitBranch ?? null,
					createdAt: s.createdAt ?? null,
					lastModified: s.lastModified,
					archived: s.archived ?? false,
					owned: owned.has(s.sessionId) ? owned.get(s.sessionId)?.state : null,
				}));
		}
		case "messages": {
			const id = text(request.sessionId, "sessionId", 128);
			const messages = await getSessionMessages(id, { dir: text(request.dir, "dir", 4096) });
			return messages.slice(-limit(request.limit)).flatMap((m) => conversationEntries(m));
		}
		case "rename": {
			const id = text(request.sessionId, "sessionId", 128);
			const dir = text(request.dir, "dir", 4096);
			const title = text(request.title, "title", 200).trim();
			await renameSession(id, title, { dir });
			const info = await getSessionInfo(id, { dir });
			if (info?.customTitle !== title) fail("rename_not_confirmed", "source kept another title");
			return { title };
		}
		case "send": {
			const content = text(request.text, "text", 100_000);
			const cwd = text(request.cwd, "cwd", 4096);
			const id = typeof request.sessionId === "string" ? request.sessionId : null;
			let session = id ? owned.get(id) : undefined;
			const started = !session;
			if (!session) {
				session = new OwnedSession(cwd, id);
				// Register a resumed session at once: a second send during the cold start must reuse
				// this streaming input instead of starting a second owner.
				if (id) owned.set(id, session);
			}
			const [sessionId, messageId] = await Promise.all([session.whenReady(), session.push(content)]);
			return { sessionId, started, messageId };
		}
		case "permission": {
			const id = text(request.sessionId, "sessionId", 128);
			const done = owned
				.get(id)
				?.answerPermission(text(request.requestId, "requestId", 64), request.allow === true);
			if (!done) fail("permission_not_pending", "no such pending permission request");
			return { answered: true };
		}
		case "owned":
			return [...owned.entries()].map(([sessionId, s]) => ({ sessionId, state: s.state }));
		case "close": {
			const id = text(request.sessionId, "sessionId", 128);
			owned.get(id)?.close();
			return { closed: true };
		}
		case "ping":
			return { ok: true };
		default:
			fail("unknown_op", `unknown op ${request.op}`);
	}
}

function main(): void {
	const lines = createInterface({ input: process.stdin });
	lines.on("line", (line) => {
		let request: Request;
		try {
			request = JSON.parse(line) as Request;
		} catch {
			emit({ id: null, ok: false, error: { code: "invalid_json", message: "invalid request" } });
			return;
		}
		handle(request).then(
			(result) => emit({ id: request.id, ok: true, result }),
			(error: unknown) => {
				const typed =
					error && typeof error === "object" && "code" in error
						? (error as BridgeError)
						: { code: "claude_failed", message: String(error).slice(0, 300) };
				emit({ id: request.id, ok: false, error: typed });
			},
		);
	});
	lines.on("close", () => {
		for (const session of owned.values()) session.close();
		process.exit(0);
	});
}

main();
