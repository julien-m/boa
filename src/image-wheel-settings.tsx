/** Explicit wheel-axis and sensitivity controls; native controls keep keyboard support. */
import { Mouse } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	defaultImageWheelPreferences,
	type ImageWheelPreferences,
	imageWheelSensitivity,
} from "./image-wheel-preferences";
import { useImageWheelPreferences } from "./use-image-wheel-preferences";

/** Render saved wheel controls and localized load/write errors; changes persist immediately. */
export function ImageWheelSettings(): ReactElement {
	const { t } = useTranslation("settings");
	const id = useId();
	const { preferences, status, setPreferences } = useImageWheelPreferences();
	const [failed, setFailed] = useState(false);
	const save = (next: ImageWheelPreferences): void => {
		try {
			setPreferences(next);
			setFailed(false);
		} catch {
			setFailed(true);
		}
	};
	return (
		<section
			className="settings-card image-wheel-settings"
			data-testid="image-wheel-settings"
			aria-labelledby={`${id}-title`}
		>
			<div className="settings-heading">
				<Mouse size={20} />
				<h2 id={`${id}-title`}>{t("imageWheel.title")}</h2>
			</div>
			<p>{t("imageWheel.description")}</p>
			<div className="image-wheel-settings-controls">
				<label className="image-wheel-settings-field">
					<span>{t("imageWheel.axis")}</span>
					<select
						data-testid="image-wheel-axis"
						value={preferences.axis}
						onChange={(event) =>
							save({ ...preferences, axis: event.target.value as ImageWheelPreferences["axis"] })
						}
					>
						<option value="tabs">{t("imageWheel.tabs")}</option>
						<option value="horizontal">{t("imageWheel.horizontal")}</option>
						<option value="vertical">{t("imageWheel.vertical")}</option>
						<option value="both">{t("imageWheel.both")}</option>
						<option value="off">{t("imageWheel.off")}</option>
					</select>
				</label>
				<div className="image-wheel-settings-field">
					<label htmlFor={`${id}-sensitivity`}>{t("imageWheel.sensitivity")}</label>
					<div className="image-wheel-sensitivity-row">
						<input
							id={`${id}-sensitivity`}
							data-testid="image-wheel-sensitivity"
							type="range"
							min={imageWheelSensitivity.min}
							max={imageWheelSensitivity.max}
							step="1"
							value={preferences.sensitivity}
							onChange={(event) => save({ ...preferences, sensitivity: Number(event.target.value) })}
						/>
						<output htmlFor={`${id}-sensitivity`} data-testid="image-wheel-sensitivity-value">
							{preferences.sensitivity} / {imageWheelSensitivity.max}
						</output>
					</div>
					<div className="image-wheel-scale muted small" aria-hidden="true">
						<span>{t("imageWheel.low")}</span>
						<span>{t("imageWheel.high")}</span>
					</div>
				</div>
			</div>
			<p className="muted small">
				{t(
					`imageWheel.${preferences.axis === "tabs" ? "tabsHint" : preferences.axis === "both" ? "bothHint" : preferences.axis === "off" ? "offHint" : "axisHint"}`,
				)}
			</p>

			{(failed || status !== "ready") && (
				<p role="alert" data-testid="image-wheel-error" className="error">
					{t(failed ? "imageWheel.saveFailed" : "imageWheel.loadFailed")}
				</p>
			)}
			<div className="settings-actions">
				<button
					className="quiet-button"
					type="button"
					data-testid="image-wheel-reset"
					onClick={() => save(defaultImageWheelPreferences)}
				>
					{t("imageWheel.reset")}
				</button>
			</div>
		</section>
	);
}
