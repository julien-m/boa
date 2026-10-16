/** Explicit opt-in to automatic local project discovery. */
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Languages, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ProjectSettings } from "./api";
import { setInterfaceLanguage } from "./i18n";

export function SettingsView({
	settings,
	onChanged,
}: {
	settings: ProjectSettings;
	onChanged: (settings: ProjectSettings) => Promise<void>;
}) {
	const { t } = useTranslation("settings");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const changeDirectory = async (choose: boolean): Promise<void> => {
		setBusy(true);
		setError("");
		try {
			const path = choose
				? await open({
						directory: true,
						multiple: false,
						title: t("dialogTitle"),
						defaultPath: settings.watchDirectory ?? undefined,
					})
				: null;
			if (choose && typeof path !== "string") return;
			await onChanged(await api.setWatchDirectory(typeof path === "string" ? path : null));
		} catch (reason) {
			setError(String(reason));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="dashboard settings-view" data-testid="settings-view">
			<div className="eyebrow">{t("eyebrow")}</div>
			<h1>{t("title")}</h1>
			<p className="dashboard-intro">{t("intro")}</p>
			<section className="settings-card language-card" aria-labelledby="language-heading">
				<div className="settings-heading">
					<Languages size={20} />
					<h2 id="language-heading">{t("languageTitle")}</h2>
				</div>
				<p>{t("languageDescription")}</p>
				<label className="language-field">
					<span>{t("languageLabel")}</span>
					<select
						data-testid="interface-language"
						value={settings.language}
						disabled={busy}
						onChange={(event) => {
							const language = event.target.value as "fr" | "en";
							setBusy(true);
							setError("");
							void api
								.setLanguage(language)
								.then(async (value) => {
									await setInterfaceLanguage(value.language);
									await onChanged(value);
								})
								.catch((reason) => setError(String(reason)))
								.finally(() => setBusy(false));
						}}
					>
						<option value="fr">Français</option>
						<option value="en">English</option>
					</select>
				</label>
				<p className="muted small">{t("languageHint")}</p>
			</section>
			<section className="settings-card" aria-labelledby="discovery-heading">
				<div className="settings-heading">
					<FolderOpen size={20} />
					<h2 id="discovery-heading">{t("discoveryTitle")}</h2>
					<span className={settings.watchDirectory ? "good" : "muted"} data-testid="discovery-mode">
						{t(settings.watchDirectory ? "automatic" : "manual")}
					</span>
				</div>
				<p>{t("description")}</p>
				<div className="settings-directory" data-testid="watch-directory">
					<FolderOpen size={16} />
					<span>{settings.watchDirectory ?? t("noDirectory")}</span>
				</div>
				<div className="settings-actions">
					<button
						type="button"
						className="quiet-button"
						data-testid="choose-watch-directory"
						disabled={busy}
						onClick={() => void changeDirectory(true)}
					>
						<FolderOpen size={14} />
						{t(settings.watchDirectory ? "change" : "choose")}
					</button>
					{settings.watchDirectory && (
						<button
							type="button"
							className="quiet-button"
							data-testid="disable-watch-directory"
							disabled={busy}
							onClick={() => void changeDirectory(false)}
						>
							{t("disable")}
						</button>
					)}
					{busy && (
						<span className="muted" role="status">
							<RefreshCw size={13} className="spin" /> {t("saving")}
						</span>
					)}
				</div>
				{(error || settings.watchError) && (
					<p className="error" role="alert">
						{error || settings.watchError}
					</p>
				)}
				<div className="settings-details">
					<p>{t("polling")}</p>
					<p>{t("preserve")}</p>
					<p>{t("manualHint")}</p>
					<p>{t("archiveHint")}</p>
				</div>
			</section>
		</div>
	);
}
