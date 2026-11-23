import { invoke } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export interface IntegrationStatus {
	installed: boolean;
	system: { extensions: { extensions: string[]; configured: boolean; partiallyConfigured?: boolean }[] };
	codex: { available: boolean; configured: boolean };
	claude: { available: boolean; supported: boolean };
}

interface IntegrationResult {
	status: IntegrationStatus;
	restartRequired: boolean;
	changed: number;
	failures: string[];
}

function assignedExtensions(status: IntegrationStatus | null): string[] {
	return (
		status?.system.extensions
			.filter((group) => group.configured || group.partiallyConfigured)
			.flatMap((group) => group.extensions) ?? []
	);
}

export function EditorIntegrations() {
	const { t } = useTranslation("settings");
	const [status, setStatus] = useState<IntegrationStatus | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const [editedPartial, setEditedPartial] = useState<string[]>([]);
	const [expanded, setExpanded] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const [busy, setBusy] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [unrestoredTypes, setUnrestoredTypes] = useState<string[]>([]);
	const groups = status?.system.extensions ?? [];
	const extensions = groups.flatMap((group) => group.extensions);
	const assigned = assignedExtensions(status);
	const removed = assigned.filter((extension) => !selected.includes(extension));
	const added = selected.filter(
		(extension) => !assigned.includes(extension) || editedPartial.includes(extension),
	);
	const allSelected =
		groups.length > 0 &&
		groups.every(
			(group) =>
				group.extensions.every((extension) => selected.includes(extension)) &&
				(!group.partiallyConfigured || editedPartial.includes(group.extensions[0])),
		);
	const canApply = !busy && status?.installed && (selected.length > 0 || removed.length > 0);

	useEffect(() => {
		let current = true;
		setBusy(true);
		setError("");
		void invoke<IntegrationStatus>("editor_integrations", { action: "status", extensions: [] })
			.then((value) => {
				if (current) {
					setStatus(value);
					setSelected(assignedExtensions(value));
					setEditedPartial([]);
				}
			})
			.catch(() => {
				if (current) {
					setStatus(null);
					setError("integrations.statusError");
				}
			})
			.finally(() => {
				if (current) setBusy(false);
			});
		return () => {
			current = false;
		};
	}, [refresh]);

	const configure = async (action: "system" | "codex") => {
		setBusy(true);
		setError("");
		setNotice("");
		setUnrestoredTypes([]);
		try {
			const result = await invoke<IntegrationResult>("editor_integrations", {
				action,
				extensions: action === "system" ? added : selected,
				...(action === "system" && removed.length > 0 ? { removeExtensions: removed } : {}),
			});
			if (action === "system") {
				setStatus(result.status);
				setSelected(assignedExtensions(result.status));
				setEditedPartial([]);
			} else {
				// Codex setup does not submit or rebase any file association edits.
				setStatus((current) => ({ ...result.status, system: current?.system ?? result.status.system }));
			}
			const restorePrefix = "restore-unavailable:";
			setUnrestoredTypes(
				result.failures
					.filter((failure) => failure.startsWith(restorePrefix))
					.map((failure) => failure.slice(restorePrefix.length)),
			);
			setNotice(
				action === "codex" && result.restartRequired
					? "integrations.codexRestart"
					: result.failures.length
						? ""
						: action === "codex"
							? "integrations.codexSaved"
							: result.changed === 0
								? "integrations.systemUnchanged"
								: "integrations.systemSaved",
			);
			if (result.failures.length)
				setError(
					result.failures.some((failure) => failure.includes("macOS confirmation is still pending"))
						? "integrations.confirmationPending"
						: "integrations.partialError",
				);
		} catch (reason) {
			setError(
				String(reason).includes("macOS confirmation is still pending")
					? "integrations.confirmationPending"
					: "integrations.actionError",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="settings-card" aria-labelledby="integrations-heading">
			<div className="settings-heading">
				<img src="/boa.svg" alt="" width={24} height={24} />
				<h2 id="integrations-heading">{t("integrations.title")}</h2>
			</div>

			{status && !status.installed && <p>{t("integrations.installFirst")}</p>}
			<div className="integration-row">
				<div>
					<h3>{t("integrations.systemTitle")}</h3>
					<p className="muted small">{t("integrations.systemDescription")}</p>
				</div>
				<button
					type="button"
					className="quiet-button"
					data-testid="integration-extensions"
					aria-expanded={expanded}
					aria-controls="integration-extension-list"
					disabled={!status || busy}
					onClick={() => setExpanded((value) => !value)}
				>
					{t("integrations.extensions", { count: selected.length })}
				</button>
			</div>
			{expanded && (
				<form
					id="integration-extension-list"
					className="integration-picker"
					onSubmit={(event) => {
						event.preventDefault();
						if (canApply) void configure("system");
					}}
				>
					<div className="settings-actions">
						<button
							type="button"
							className="quiet-button"
							data-testid="integration-select-all"
							disabled={busy || extensions.length === 0}
							onClick={() => {
								setNotice("");
								setSelected(allSelected ? [] : extensions);
								setEditedPartial(
									groups.filter((group) => group.partiallyConfigured).flatMap((group) => group.extensions),
								);
							}}
						>
							{t(allSelected ? "integrations.deselectAll" : "integrations.selectAll")}
						</button>
					</div>
					<div className="integration-extension-grid">
						{groups.map(({ extensions: aliases, partiallyConfigured }) => (
							<label key={aliases[0]}>
								<input
									type="checkbox"
									ref={(input) => {
										if (input)
											input.indeterminate = Boolean(
												partiallyConfigured && !editedPartial.includes(aliases[0]),
											);
									}}
									checked={aliases.every((extension) => selected.includes(extension))}
									disabled={busy}
									data-extension={aliases[0]}
									onChange={(event) => {
										setNotice("");
										if (partiallyConfigured)
											setEditedPartial((items) => [...new Set([...items, ...aliases])]);
										setSelected((items) =>
											event.target.checked
												? [...new Set([...items, ...aliases])]
												: items.filter((item) => !aliases.includes(item)),
										);
									}}
								/>
								<span>{aliases.map((extension) => `.${extension}`).join(" / ")}</span>
							</label>
						))}
					</div>
					<div className="settings-actions">
						<span className="muted small">{t("integrations.selectionHint")}</span>
						<button
							type="submit"
							className="quiet-button"
							data-testid="integration-system"
							disabled={!canApply}
						>
							{t(busy ? "integrations.applying" : "integrations.systemAction")}
						</button>
					</div>
				</form>
			)}
			<div className="integration-row">
				<div>
					<h3>Codex</h3>
					<p className="muted small">{t("integrations.codexDescription")}</p>
				</div>
				<button
					type="button"
					className="quiet-button"
					data-testid="integration-codex"
					disabled={busy || !status?.installed || !status.codex.available}
					onClick={() => void configure("codex")}
				>
					{t(status?.codex.configured ? "integrations.codexSaved" : "integrations.codexAction")}
				</button>
			</div>
			<div className="integration-row">
				<h3>Claude Desktop</h3>
				<span className="muted small">{t("integrations.claudeUnsupported")}</span>
			</div>
			<div className="integration-feedback" data-testid="integration-status" role="status" aria-live="polite">
				{busy && (
					<p className="muted">
						<RefreshCw size={13} className="spin" /> {t("integrations.working")}
					</p>
				)}
				{notice && <p>{t(notice)}</p>}
			</div>
			{error && (
				<div className="error" role="alert">
					<p>{t(error)}</p>
					{unrestoredTypes.length > 0 && (
						<ul>
							{[...new Set(unrestoredTypes)].map((types) => (
								<li key={types}>{t("integrations.restoreUnavailable", { types })}</li>
							))}
						</ul>
					)}
				</div>
			)}
			{error === "integrations.statusError" && (
				<button
					type="button"
					className="quiet-button"
					disabled={busy}
					onClick={() => setRefresh((value) => value + 1)}
				>
					{t("integrations.retry")}
				</button>
			)}
		</section>
	);
}
