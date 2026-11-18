/**
 * View of the session's persistent backend terminal. Unmounting only detaches the view;
 * the PTY keeps running in BOA until closed explicitly.
 */
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { useSessionText } from "./session-labels";
import { keyId, type SessionKey, SessionsError, sessionsApi } from "./sessions-api";
import { TerminalStream } from "./terminal-stream";

function decode(base64: string): Uint8Array {
	return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

export function SessionTerminal({
	sessionKey,
	attachOnly = false,
	onRestart,
}: {
	sessionKey: SessionKey;
	/** Restored view: attach to the running PTY only; an ended one shows as exited. */
	attachOnly?: boolean;
	/** Explicit new start after the process ended; never called automatically. */
	onRestart?: () => void;
}) {
	const { t, error } = useSessionText();
	const host = useRef<HTMLDivElement>(null);
	const [failure, setFailure] = useState("");
	const [terminalId, setTerminalId] = useState<string | null>(null);
	const [exited, setExited] = useState(false);
	// Latest translator without restarting the terminal view when the language changes.
	const describe = useRef(error);
	describe.current = error;
	// Identity, not object reference: storage sync recreates equal keys.
	const target = keyId(sessionKey);
	const latestKey = useRef(sessionKey);
	latestKey.current = sessionKey;
	const attachOnlyRef = useRef(attachOnly);
	attachOnlyRef.current = attachOnly;

	useEffect(() => {
		const element = host.current;
		if (!element) return;
		// A new target starts clean: no terminal id, exit or error of the previous session.
		setTerminalId(null);
		setExited(false);
		setFailure("");
		let disposed = false;
		let id: string | null = null;
		const term = new Terminal({
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
			fontSize: 12,
			theme: {
				background: "#1c1d21",
				foreground: "#e0e2e8",
				cursor: "#a9c1ff",
				selectionBackground: "#303e60",
			},
			scrollback: 5000,
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(element);
		fit.fit();
		// Listening starts before the open request: events racing it are buffered, then
		// reconciled with the snapshot by byte offset (no loss, no duplicate).
		const stream = new TerminalStream((bytes) => term.write(bytes));
		const owner = latestKey.current;
		const stopListening = listen<{
			event: string;
			terminalId: string;
			provider: string;
			sessionId: string;
			offset?: number;
			end?: number;
			data?: string;
		}>("boa:terminal", ({ payload }) => {
			if (disposed) return;
			if (payload.provider !== owner.provider || payload.sessionId !== owner.id) return;
			if (payload.event === "output" && payload.data !== undefined && payload.offset !== undefined)
				stream.push({
					event: "output",
					terminalId: payload.terminalId,
					offset: payload.offset,
					data: decode(payload.data),
				});
			if (payload.event === "exit")
				stream.push({ event: "exit", terminalId: payload.terminalId, end: payload.end ?? 0 });
			if (stream.exited) setExited(true);
		});
		const input = term.onData((data) => {
			if (id)
				void sessionsApi
					.terminalWrite(id, data)
					.catch((value: unknown) => setFailure(describe.current(value)));
		});
		const resize = new ResizeObserver(() => {
			fit.fit();
			if (id) void sessionsApi.terminalResize(id, term.cols, term.rows).catch(() => undefined);
		});
		resize.observe(element);
		void stopListening.then(() =>
			sessionsApi.openTerminal(latestKey.current, term.cols, term.rows, attachOnlyRef.current).then(
				(info) => {
					if (disposed) return;
					id = info.terminalId;
					setTerminalId(info.terminalId);
					// Writes the snapshot, then buffered events past its end; live output follows.
					stream.attach(info.terminalId, decode(info.snapshot), info.snapshotEnd, info.running);
					setExited(stream.exited);
					term.focus();
				},
				(value: unknown) => {
					if (disposed) return;
					// Ended meanwhile: offer an explicit start rather than an error.
					if (value instanceof SessionsError && value.code === "terminal_not_running") setExited(true);
					else setFailure(describe.current(value));
				},
			),
		);
		return () => {
			disposed = true;
			resize.disconnect();
			input.dispose();
			void stopListening.then((stop) => stop());
			term.dispose();
		};
	}, [target]);

	return (
		<div className="session-terminal">
			{failure && <p className="session-feedback error">{failure}</p>}
			{exited && (
				<div className="session-terminal-exited">
					<p className="session-feedback">{t("terminal.exited")}</p>
					{onRestart && (
						<button type="button" className="quiet-button" onClick={onRestart}>
							{t("terminal.start")}
						</button>
					)}
				</div>
			)}
			<div
				ref={host}
				className="session-terminal-screen"
				role="application"
				aria-label={t("terminal.label")}
			/>
			{terminalId && !exited && (
				<div className="session-actions-row">
					<small className="muted">{t("terminal.persistent")}</small>
					<button
						type="button"
						className="quiet-button"
						onClick={() =>
							void sessionsApi.closeTerminal(terminalId).then(
								() => setExited(true),
								(value: unknown) => setFailure(error(value)),
							)
						}
					>
						{t("terminal.stop")}
					</button>
				</div>
			)}
		</div>
	);
}
