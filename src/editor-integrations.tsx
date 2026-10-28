import { invoke } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export interface IntegrationStatus {
	installed: boolean;
	system: { extensions: { extensions: string[]; configured: boolean }[] };
	codex: { available: boolean; configured: boolean };
	claude: { available: boolean; supported: boolean };
}

interface IntegrationResult {
	status: IntegrationStatus;
	restartRequired: boolean;
	changed: number;
	failures: string[];
}

export function EditorIntegrations() {
	const { t } = useTranslation("settings");
	const [status, setStatus] = useState<IntegrationStatus | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const [expanded, setExpanded] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const [busy, setBusy] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const groups = status?.system.extensions ?? [];
	const extensions = groups.flatMap((group) => group.extensions);
	const allSelected = extensions.length > 0 && extensions.every((extension) => selected.includes(extension));

	useEffect(() => {
		let current = true;
		setBusy(true);
		setError("");
		void invoke<IntegrationStatus>("editor_integrations", { action: "status", extensions: [] })
			.then((value) => {
				if (current) {
					setStatus(value);
					setSelected(
						value.system.extensions.filter((item) => item.configured).flatMap((item) => item.extensions),
					);
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
		try {
			const result = await invoke<IntegrationResult>("editor_integrations", { action, extensions: selected });
			setStatus(result.status);
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
				<div id="integration-extension-list" className="integration-picker">
					<div className="settings-actions">
						<button
							type="button"
							className="quiet-button"
							data-testid="integration-select-all"
							disabled={busy || extensions.length === 0}
							onClick={() => {
								setNotice("");
								setSelected(allSelected ? [] : extensions);
							}}
						>
							{t(allSelected ? "integrations.deselectAll" : "integrations.selectAll")}
						</button>
					</div>
					<div className="integration-extension-grid">
						{groups.map(({ extensions: aliases }) => (
							<label key={aliases[0]}>
								<input
									type="checkbox"
									checked={aliases.every((extension) => selected.includes(extension))}
									disabled={busy}
									data-extension={aliases[0]}
									onChange={(event) => {
										setNotice("");
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
							type="button"
							className="quiet-button"
							data-testid="integration-system"
							disabled={busy || !status?.installed || selected.length === 0}
							onClick={() => void configure("system")}
						>
							{t(busy ? "integrations.applying" : "integrations.systemAction")}
						</button>
					</div>
				</div>
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
				<p className="error" role="alert">
					{t(error)}
				</p>
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
