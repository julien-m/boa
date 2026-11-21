/**
 * Settings for session action buttons and session pins: global values with per-project
 * overrides, edited as a draft and saved atomically (Enregistrer) or discarded (Annuler).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { previewTemplate } from "./action-template";
import { useSessionDock } from "./session-dock-state";
import { useSessionText } from "./session-labels";
import {
	type ActionDef,
	type ActionsView,
	keyId,
	type Provider,
	type ResolvedAction,
	sessionsApi,
} from "./sessions-api";
import { useSessionsSettings } from "./sessions-view";

type Draft = { base: ActionsView; actions: ResolvedAction[] };
const PROVIDERS: Provider[] = ["codex", "claude"];

function slug(label: string, taken: Set<string>): string {
	const base =
		label
			.normalize("NFD")
			.replace(/[̀-ͯ]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 32) || "action";
	let candidate = base;
	for (let index = 2; taken.has(candidate); index++) candidate = `${base}-${index}`;
	return candidate;
}

function strip(action: ResolvedAction): ActionDef {
	const { origin: _origin, ...definition } = action;
	return definition;
}

function PinPreferences() {
	const { t, error } = useSessionText();
	const settings = useSessionsSettings();
	const queryClient = useQueryClient();
	const autoPin = useMutation({
		mutationFn: (enabled: boolean) => sessionsApi.setAutoPin(enabled, settings.data?.revision),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["sessions"] }),
	});
	const discovery = useMutation({
		mutationFn: (enabled: boolean) => sessionsApi.setDiscovery(enabled, settings.data?.revision),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["sessions"] }),
	});
	if (!settings.data) return null;
	return (
		<div className="settings-card session-actions-row" data-testid="session-pin-preferences">
			<label className="session-actions-row">
				<input
					type="checkbox"
					{...({ switch: "" } as Record<string, string>)}
					role="switch"
					checked={settings.data.autoPinNew}
					disabled={autoPin.isPending}
					onChange={(event) => autoPin.mutate(event.target.checked)}
				/>
				<span>
					{t("actions.autoPin")}
					<br />
					<small className="muted">{t("actions.autoPinHint")}</small>
				</span>
			</label>
			<label className="session-actions-row">
				<input
					type="checkbox"
					{...({ switch: "" } as Record<string, string>)}
					role="switch"
					checked={settings.data.discoveryEnabled}
					disabled={discovery.isPending}
					onChange={(event) => discovery.mutate(event.target.checked)}
				/>
				<span>{t("discovery.title")}</span>
			</label>
			{(autoPin.isError || discovery.isError) && (
				<span className="session-feedback error">{error(autoPin.error ?? discovery.error)}</span>
			)}
		</div>
	);
}

export function SessionActionsSettings({ projects }: { projects: { path: string; name: string }[] }) {
	const { t, provider, error } = useSessionText();
	const id = useId();
	const dock = useSessionDock();
	const queryClient = useQueryClient();
	const [project, setProject] = useState<string | null>(null);
	const projectName = projects.find((item) => item.path === project)?.name ?? "";
	const saved = useQuery({
		queryKey: ["sessions", "actions", project ?? ""],
		queryFn: () => sessionsApi.actions(project),
	});
	const [drafts, setDrafts] = useState(() => new Map<string | null, Draft>());
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [notice, setNotice] = useState("");
	const template = useRef<HTMLTextAreaElement>(null);
	const draft = drafts.get(project);
	const actions = draft?.actions ?? saved.data?.actions ?? [];
	const selected = actions.find((action) => action.id === selectedId) ?? actions[0] ?? null;
	const conflict =
		!!draft && !!saved.data && JSON.stringify(draft.base.actions) !== JSON.stringify(saved.data.actions);
	const discardDraft = (scope: string | null, expected: Draft | undefined) => {
		setDrafts((current) => {
			if (!expected || current.get(scope) !== expected) return current;
			const updated = new Map(current);
			updated.delete(scope);
			return updated;
		});
	};
	const setDraft = (update: ResolvedAction[] | ((current: ResolvedAction[]) => ResolvedAction[])) => {
		const latest = saved.data;
		if (!latest) return;
		setNotice("");
		setDrafts((current) => {
			const existing = current.get(project);
			const base = existing?.base ?? latest;
			const next = typeof update === "function" ? update(existing?.actions ?? base.actions) : update;
			const updated = new Map(current);
			if (JSON.stringify(next) === JSON.stringify(base.actions)) updated.delete(project);
			else updated.set(project, { base, actions: next });
			return updated;
		});
	};
	const refreshActions = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: ["sessions", "actions"] }),
			queryClient.invalidateQueries({ queryKey: ["sessions", "settings"] }),
		]);
	const save = useMutation({
		mutationFn: (input: { project: string | null; draft: Draft; revision: number }) =>
			sessionsApi.replaceActions(input.project, input.draft.actions.map(strip), input.revision),
		onSuccess: async (_, input) => {
			await refreshActions();
			discardDraft(input.project, input.draft);
			setNotice(t("actions.saved"));
		},
		onError: (value) => setNotice(error(value)),
	});
	const reset = useMutation({
		mutationFn: () => sessionsApi.resetActions(project as string, saved.data?.revision ?? 0),
		onSuccess: refreshActions,
		onError: (value) => setNotice(error(value)),
	});
	const docked = useQuery({
		queryKey: ["sessions", "list", { scope: "all" }],
		queryFn: () => sessionsApi.list({ scope: "all" }),
		enabled: dock.current !== null,
	});
	const dockedSession = docked.data?.sessions.find(
		(item) => dock.current && keyId(item.key) === keyId(dock.current),
	);
	const branch = useQuery({
		queryKey: ["sessions", "branch", dock.current ? keyId(dock.current) : ""],
		queryFn: () => sessionsApi.branch(dock.current as NonNullable<typeof dock.current>),
		enabled: dock.current !== null,
	});
	const preview = useMemo(
		() =>
			selected
				? previewTemplate(selected.template, {
						project: projects.find((item) => item.path === dockedSession?.project)?.name,
						branch: branch.data?.current,
					})
				: null,
		[selected, projects, dockedSession, branch.data],
	);

	const change = (next: Partial<ActionDef>) =>
		setDraft((current) =>
			current.map((action) => (action.id === selected?.id ? { ...action, ...next } : action)),
		);
	const move = (index: number, offset: number) =>
		setDraft((current) => {
			const list = [...current];
			const [item] = list.splice(index, 1);
			list.splice(index + offset, 0, item);
			return list;
		});
	const add = () => {
		const label = t("actions.newLabel");
		const action: ResolvedAction = {
			id: slug(label, new Set(actions.map((item) => item.id))),
			label,
			template: t("actions.newTemplate"),
			mode: "prepare",
			providers: [...PROVIDERS],
			enabled: true,
			origin: project ? "project" : "global",
		};
		setDraft([...actions, action]);
		setSelectedId(action.id);
	};
	const insert = (token: string) => {
		const area = template.current;
		if (!selected || !area) return;
		const start = area.selectionStart ?? selected.template.length;
		const end = area.selectionEnd ?? start;
		change({ template: `${selected.template.slice(0, start)}${token}${selected.template.slice(end)}` });
		requestAnimationFrame(() => {
			area.focus();
			area.setSelectionRange(start + token.length, start + token.length);
		});
	};
	const removable = selected && (project === null || selected.origin === "project");

	return (
		<section
			className="session-actions-settings"
			aria-labelledby={`${id}-title`}
			data-testid="session-actions-settings"
		>
			<h2 id={`${id}-title`}>{t("actions.title")}</h2>
			<PinPreferences />
			<div className="actions-scope">
				<div className="segmented" role="tablist" aria-label={t("actions.title")}>
					<button
						type="button"
						role="tab"
						aria-selected={project === null}
						className={project === null ? "selected" : ""}
						disabled={save.isPending || reset.isPending}
						onClick={() => setProject(null)}
					>
						{t("actions.global")}
					</button>
					<select
						aria-label={t("projectFilter")}
						value={project ?? ""}
						disabled={save.isPending || reset.isPending}
						onChange={(event) => setProject(event.target.value || null)}
					>
						<option value="">{t("projectFilter")}…</option>
						{projects.map((item) => (
							<option key={item.path} value={item.path}>
								{t("actions.projectScope", { project: item.name })}
							</option>
						))}
					</select>
				</div>
				{project && <small className="muted">{t("actions.inherits", { project: projectName })}</small>}
			</div>
			<div className="actions-layout" inert={save.isPending || reset.isPending}>
				<div className="session-actions-settings">
					<div className="action-list-header">
						<span>{t("actions.buttons")}</span>
						<span>
							{t("actions.shownCount", {
								shown: actions.filter((action) => action.enabled).length,
								total: actions.length,
							})}
						</span>
					</div>
					<ul className="action-list">
						{actions.map((action, index) => (
							<li
								key={action.id}
								className={`action-item ${action.id === selected?.id ? "selected" : ""} ${action.enabled ? "" : "disabled"}`}
							>
								<button
									type="button"
									className="action-item-label"
									aria-current={action.id === selected?.id ? "true" : undefined}
									onClick={() => setSelectedId(action.id)}
								>
									<span>{action.label}</span>
									<small>
										{action.providers.length === PROVIDERS.length
											? t("actions.allTools")
											: action.providers.map(provider).join(", ")}{" "}
										· {action.mode === "send" ? t("actions.modeSend") : t("actions.modePrepare")}
										{!action.enabled && ` · ${t("actions.hidden")}`}
									</small>
								</button>
								{project && action.origin !== "global" ? (
									<span className="action-origin">{projectName}</span>
								) : (
									<span />
								)}
								<input
									type="checkbox"
									{...({ switch: "" } as Record<string, string>)}
									role="switch"
									aria-label={t("actions.enabled", { label: action.label })}
									checked={action.enabled}
									onChange={(event) =>
										setDraft(
											actions.map((item) =>
												item.id === action.id ? { ...item, enabled: event.target.checked } : item,
											),
										)
									}
								/>
								<span className="session-actions-row">
									<button
										type="button"
										className="icon-button"
										aria-label={`${t("actions.moveUp")} ${action.label}`}
										disabled={index === 0}
										onClick={() => move(index, -1)}
									>
										<ChevronUp size={13} />
									</button>
									<button
										type="button"
										className="icon-button"
										aria-label={`${t("actions.moveDown")} ${action.label}`}
										disabled={index === actions.length - 1}
										onClick={() => move(index, 1)}
									>
										<ChevronDown size={13} />
									</button>
								</span>
							</li>
						))}
					</ul>
					<button type="button" className="quiet-button" onClick={add}>
						<Plus size={13} />
						{t("actions.add")}
					</button>
				</div>
				{selected && (
					<div className="action-editor">
						<div className="action-editor-title">
							<h3>{t("actions.edit", { label: selected.label })}</h3>
							<small className="muted">
								{selected.origin === "project"
									? t("actions.projectOnly")
									: selected.origin === "overridden"
										? t("actions.overridden")
										: project
											? t("actions.inherited")
											: ""}
							</small>
						</div>
						<div className="action-editor-column">
							<label className="field">
								<span>{t("actions.label")}</span>
								<input
									value={selected.label}
									maxLength={60}
									onChange={(event) => change({ label: event.target.value })}
								/>
							</label>
							<fieldset className="mode-options">
								<legend className="field">{t("actions.behavior")}</legend>
								{(["prepare", "send"] as const).map((mode) => (
									<label key={mode} className="mode-option">
										<input
											type="radio"
											name={`${id}-mode`}
											checked={selected.mode === mode}
											onChange={() => change({ mode })}
										/>
										<span>{mode === "prepare" ? t("actions.prepareTitle") : t("actions.sendTitle")}</span>
										<small>{mode === "prepare" ? t("actions.prepareHint") : t("actions.sendHint")}</small>
									</label>
								))}
							</fieldset>
							<fieldset className="mode-options">
								<legend className="field">{t("actions.providers")}</legend>
								<div className="provider-options">
									{PROVIDERS.map((value) => (
										<label key={value} className="session-actions-row">
											<input
												type="checkbox"
												checked={selected.providers.includes(value)}
												onChange={(event) =>
													change({
														providers: event.target.checked
															? [...selected.providers, value]
															: selected.providers.filter((item) => item !== value),
													})
												}
											/>
											{provider(value)}
										</label>
									))}
								</div>
							</fieldset>
						</div>
						<div className="action-editor-column">
							<label className="field">
								<span>{t("actions.template")}</span>
								<textarea
									ref={template}
									value={selected.template}
									maxLength={8000}
									onChange={(event) => change({ template: event.target.value })}
								/>
							</label>
							<div className="variable-buttons" role="group" aria-label={t("actions.insert")}>
								<span className="muted">{t("actions.insert")}</span>
								{(["project", "branch", "selection", "file"] as const).map((variable) => (
									<button
										key={variable}
										type="button"
										onClick={() => insert(t(`actions.variables.${variable}`))}
									>
										{t(`actions.variables.${variable}`)}
									</button>
								))}
							</div>
							<span className="field">{t("actions.preview")}</span>
							{dockedSession ? (
								<small className="muted">
									{t("context.to")} {dockedSession.title} · {provider(dockedSession.key.provider)}
									{branch.data?.current && ` / ${branch.data.current}`}
								</small>
							) : (
								<small className="muted">{t("actions.previewNoSession")}</small>
							)}
							<pre className="action-preview">{preview?.text}</pre>
						</div>
					</div>
				)}
			</div>
			<div className="actions-footer">
				<span className="session-feedback" role="status">
					{conflict && !save.isPending
						? t("errors.revision_conflict")
						: notice || (draft && t("actions.unsaved"))}
				</span>
				{project && saved.data?.actions.some((action) => action.origin !== "global") && (
					<button
						type="button"
						className="quiet-button"
						disabled={!!draft || reset.isPending || save.isPending}
						onClick={() => reset.mutate()}
					>
						{t("actions.reset")}
					</button>
				)}
				{removable && (
					<button
						type="button"
						className="quiet-button"
						disabled={save.isPending || reset.isPending}
						onClick={() => setDraft(actions.filter((action) => action.id !== selected.id))}
					>
						{t("actions.remove")}
					</button>
				)}
				<button
					type="button"
					className="quiet-button"
					disabled={!draft || save.isPending}
					onClick={() => {
						discardDraft(project, draft);
						setNotice("");
					}}
				>
					{t("actions.cancel")}
				</button>
				<button
					type="button"
					className="primary-button"
					disabled={!draft || !saved.data || conflict || save.isPending || reset.isPending}
					onClick={() => {
						if (draft && saved.data && !conflict)
							save.mutate({ project, draft, revision: saved.data.revision });
					}}
				>
					{t("actions.save")}
				</button>
			</div>
		</section>
	);
}
