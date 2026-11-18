/**
 * Conversation read from the provider's own history, as one left-aligned column: speaker and
 * time when known, Markdown rendered as untrusted text, copyable code and technical events
 * folded together. Keeps its scroll per session.
 */
import { useQuery } from "@tanstack/react-query";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ChevronDown } from "lucide-react";
import { Children, isValidElement, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getLocale } from "../i18n";
import { useSessionDock } from "./session-dock-state";
import { useSessionText } from "./session-labels";
import { type ConversationEntry, keyId, type Provider, type SessionKey, sessionsApi } from "./sessions-api";

/** Enough recent context for the dock; older history stays in the provider. */
const CONVERSATION_LIMIT = 80;

export type ConversationBlock =
	| { kind: "message"; entry: ConversationEntry }
	| { kind: "events"; entries: ConversationEntry[] };

/** Consecutive technical entries (commands, tool calls) become one folded block. */
export function conversationBlocks(entries: ConversationEntry[]): ConversationBlock[] {
	const blocks: ConversationBlock[] = [];
	for (const entry of entries) {
		const last = blocks.at(-1);
		if (entry.role !== "tool") blocks.push({ kind: "message", entry });
		else if (last?.kind === "events") last.entries.push(entry);
		else blocks.push({ kind: "events", entries: [entry] });
	}
	return blocks;
}

/** Display names for common fence tags; any other tag is shown as written. */
const LANGUAGE_NAMES: Record<string, string> = {
	ts: "TypeScript",
	typescript: "TypeScript",
	tsx: "TSX",
	js: "JavaScript",
	javascript: "JavaScript",
	jsx: "JSX",
	rs: "Rust",
	rust: "Rust",
	py: "Python",
	python: "Python",
	sh: "Shell",
	bash: "Shell",
	zsh: "Shell",
	shell: "Shell",
	json: "JSON",
	css: "CSS",
	html: "HTML",
	swift: "Swift",
	md: "Markdown",
	markdown: "Markdown",
};

function languageOf(children: ReactNode): string {
	const code = Children.toArray(children).find((child) => isValidElement<{ className?: string }>(child));
	const className = isValidElement<{ className?: string }>(code) ? (code.props.className ?? "") : "";
	const tag = /language-([\w+#-]+)/.exec(className)?.[1] ?? "";
	return LANGUAGE_NAMES[tag.toLowerCase()] ?? tag;
}

function CodeBlock({ children }: { children?: ReactNode }) {
	const { t } = useSessionText();
	const body = useRef<HTMLPreElement>(null);
	const [copied, setCopied] = useState<"done" | "failed" | null>(null);
	const language = languageOf(children);
	return (
		<figure className="conversation-code">
			<figcaption>
				<span>{language || t("conversation.code")}</span>
				<button
					type="button"
					className="quiet-button"
					onClick={() =>
						void writeText(body.current?.textContent ?? "").then(
							() => setCopied("done"),
							() => setCopied("failed"),
						)
					}
				>
					{copied === "done" ? t("conversation.copied") : t("conversation.copy")}
				</button>
				<span className="sr-only" role="status">
					{copied === "done"
						? t("conversation.copied")
						: copied === "failed"
							? t("conversation.copyFailed")
							: ""}
				</span>
			</figcaption>
			<pre ref={body}>{children}</pre>
		</figure>
	);
}

/**
 * History is untrusted: raw HTML is dropped, images are never fetched and links never
 * navigate (their target stays readable in the tooltip).
 */
export function ConversationMarkdown({ text }: { text: string }) {
	const { t } = useSessionText();
	return (
		<Markdown
			remarkPlugins={[remarkGfm]}
			skipHtml
			components={{
				pre: CodeBlock,
				a: ({ href, children }) => (
					<span className="conversation-link" title={href}>
						{children}
					</span>
				),
				img: ({ alt }) => (
					<span className="conversation-image">{t("conversation.image", { alt: alt || "—" })}</span>
				),
			}}
		>
			{text}
		</Markdown>
	);
}

function time(at: number | undefined): { short: string; full: string } | null {
	if (!at) return null;
	const locale = getLocale();
	return {
		short: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(at),
		full: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at),
	};
}

function Message({ entry, provider }: { entry: ConversationEntry; provider: Provider }) {
	const { t, provider: tool } = useSessionText();
	const when = time(entry.at);
	return (
		<article className={`conversation-message entry-${entry.role}`}>
			<header className="conversation-speaker">
				<strong>{entry.role === "user" ? t("conversation.you") : tool(provider)}</strong>
				{when && (
					<time dateTime={new Date(entry.at as number).toISOString()} title={when.full}>
						{when.short}
					</time>
				)}
			</header>
			<div className="conversation-body">
				<ConversationMarkdown text={entry.text} />
			</div>
		</article>
	);
}

function Events({ entries }: { entries: ConversationEntry[] }) {
	const { t } = useSessionText();
	return (
		<details className="conversation-events">
			<summary>
				{/* App convention: the chevron turns right while the details are closed. */}
				<ChevronDown size={13} aria-hidden="true" />
				{t("conversation.events", { count: entries.length })}
			</summary>
			<ol>
				{entries.map((entry, index) => (
					// Entries have no stable id in every source; order within one read is stable.
					<li key={`${index}-${entry.text}`}>
						<code>{entry.text}</code>
					</li>
				))}
			</ol>
		</details>
	);
}

export function SessionConversation({ sessionKey }: { sessionKey: SessionKey }) {
	const { t, error } = useSessionText();
	const dock = useSessionDock();
	const scroller = useRef<HTMLDivElement>(null);
	const conversation = useQuery({
		queryKey: ["sessions", "conversation", keyId(sessionKey)],
		queryFn: () => sessionsApi.conversation(sessionKey, CONVERSATION_LIMIT),
	});
	const entries = conversation.data ?? [];
	useLayoutEffect(() => {
		const element = scroller.current;
		if (!element || !conversation.data) return;
		const saved = dock.scrollFor(sessionKey);
		// First display goes to the latest message; later refreshes keep the reader's position.
		element.scrollTop = saved < 0 ? element.scrollHeight : saved;
	}, [conversation.data, sessionKey, dock]);
	return (
		<div
			ref={scroller}
			className="session-conversation"
			role="log"
			aria-label={t("dock.conversation")}
			aria-busy={conversation.isFetching}
			onScroll={(event) => dock.setScroll(sessionKey, event.currentTarget.scrollTop)}
		>
			<div className="conversation-column">
				{conversation.isLoading && <p className="muted">{t("dock.loadingConversation")}</p>}
				{conversation.isError && <p className="session-feedback error">{error(conversation.error)}</p>}
				{conversation.data && entries.length === 0 && <p className="muted">{t("dock.emptyConversation")}</p>}
				{conversationBlocks(entries).map((block, index) =>
					block.kind === "events" ? (
						<Events key={`events-${index}`} entries={block.entries} />
					) : (
						<Message
							key={`${index}-${block.entry.role}`}
							entry={block.entry}
							provider={sessionKey.provider}
						/>
					),
				)}
			</div>
		</div>
	);
}
