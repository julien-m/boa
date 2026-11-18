/**
 * Open session tabs of the dock: intrinsic width, title then state dot, × on each tab and a
 * « + » menu to open another session or come back to a BOA terminal still running behind a
 * closed tab. Closing a tab never stops a session or a terminal.
 */
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { MenuItem, PopoverMenu } from "./popover-menu";
import { useSessionDock } from "./session-dock-state";
import { useSessionText } from "./session-labels";
import { keyId, type SessionKey, type SessionSummary, sameKey, sessionsApi } from "./sessions-api";

/** Sessions offered by « + »: the most recent ones, enough to reopen without a search field. */
const MENU_SESSIONS = 8;

export function tabId(key: SessionKey): string {
	return `session-tab-${key.provider}-${key.id}`;
}

export function panelId(key: SessionKey): string {
	return `session-panel-${key.provider}-${key.id}`;
}

export function SessionTabs({ catalog }: { catalog: SessionSummary[] }) {
	const { t, state } = useSessionText();
	const dock = useSessionDock();
	const running = useQuery({ queryKey: ["sessions", "terminals"], queryFn: sessionsApi.terminals });
	const summary = (key: SessionKey) => catalog.find((item) => sameKey(item.key, key)) ?? null;
	const title = (key: SessionKey) => summary(key)?.title || key.id;
	const notOpen = (key: SessionKey) => !dock.tabs.some((tab) => sameKey(tab, key));
	const background = (running.data ?? []).filter((item) => notOpen(item.session));
	const others = [...catalog]
		.filter((item) => notOpen(item.key))
		.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
		.slice(0, MENU_SESSIONS);

	const focusTab = (key: SessionKey | undefined) => {
		if (!key) return;
		requestAnimationFrame(() => document.getElementById(tabId(key))?.focus());
	};
	const close = (key: SessionKey) => {
		const index = dock.tabs.findIndex((tab) => sameKey(tab, key));
		const next = dock.tabs.filter((tab) => !sameKey(tab, key));
		dock.closeTab(key);
		focusTab(next[Math.min(index, next.length - 1)]);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
		const count = dock.tabs.length;
		const target =
			event.key === "ArrowRight"
				? (index + 1) % count
				: event.key === "ArrowLeft"
					? (index - 1 + count) % count
					: event.key === "Home"
						? 0
						: event.key === "End"
							? count - 1
							: null;
		if (target !== null) {
			event.preventDefault();
			// Manual activation would hide the reader's place; tabs follow focus like most IDEs.
			dock.show(dock.tabs[target] as SessionKey);
			focusTab(dock.tabs[target]);
			return;
		}
		if (event.key === "Delete" || event.key === "Backspace") {
			event.preventDefault();
			close(dock.tabs[index] as SessionKey);
		}
	};

	return (
		<div className="session-tabs">
			<div className="session-tab-list" role="tablist" aria-label={t("tabs.label")}>
				{dock.tabs.map((key, index) => {
					const selected = sameKey(key, dock.current);
					const session = summary(key);
					const name = title(key);
					return (
						<div
							key={keyId(key)}
							className={`session-tab ${selected ? "selected" : ""}`}
							data-testid={`session-tab-${key.id}`}
						>
							<button
								type="button"
								role="tab"
								id={tabId(key)}
								aria-selected={selected}
								aria-controls={selected ? panelId(key) : undefined}
								tabIndex={selected ? 0 : -1}
								title={name}
								className="session-tab-button"
								onClick={() => dock.show(key)}
								onKeyDown={(event) => onKeyDown(event, index)}
							>
								<span className="session-tab-title">{name}</span>
								{session && (
									<span className={`session-tab-state state-${session.state}`}>
										<span className="session-state-dot" aria-hidden="true" />
										<span className="sr-only">{state(session.state)}</span>
									</span>
								)}
							</button>
							<button
								type="button"
								className="session-tab-close"
								// Keyboard users close with Delete on the tab; the × stays out of the Tab order.
								tabIndex={-1}
								aria-label={t("tabs.close", { title: name })}
								data-hint={t("tabs.closeHint")}
								data-testid={`close-session-tab-${key.id}`}
								onClick={() => close(key)}
							>
								<X size={12} aria-hidden="true" />
							</button>
						</div>
					);
				})}
			</div>
			<PopoverMenu label={t("tabs.open")} trigger={<Plus size={14} />}>
				{(closeMenu) => (
					<>
						{background.length > 0 && (
							<>
								<span className="popover-menu-heading" role="presentation">
									{t("tabs.background")}
								</span>
								{background.map((item) => (
									<MenuItem
										key={item.terminalId}
										close={closeMenu}
										onSelect={() => {
											dock.setView(item.session, "terminal");
											dock.show(item.session);
										}}
									>
										{t("tabs.backgroundItem", { title: title(item.session) })}
									</MenuItem>
								))}
							</>
						)}
						<span className="popover-menu-heading" role="presentation">
							{t("tabs.recent")}
						</span>
						{others.length === 0 && (
							<MenuItem close={closeMenu} disabled onSelect={() => undefined}>
								{t("tabs.noOther")}
							</MenuItem>
						)}
						{others.map((item) => (
							<MenuItem key={keyId(item.key)} close={closeMenu} onSelect={() => dock.show(item.key)}>
								{item.title || item.key.id}
							</MenuItem>
						))}
					</>
				)}
			</PopoverMenu>
		</div>
	);
}
