/** Presentation helpers: localized provider, state, receipt and error texts. */
import { useTranslation } from "react-i18next";
import { getLocale } from "../i18n";
import { type Provider, type SendReceipt, type SessionState, SessionsError } from "./sessions-api";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Relative time such as « il y a 2 min » plus an absolute short date for the second line. */
export function activityParts(
	at: number | null,
	now = Date.now(),
): { relative: string; absolute: string } | null {
	if (!at) return null;
	const locale = getLocale();
	const elapsed = Math.max(0, now - at);
	const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
	const relative =
		elapsed < MINUTE
			? format.format(-Math.round(elapsed / 1000), "second")
			: elapsed < HOUR
				? format.format(-Math.round(elapsed / MINUTE), "minute")
				: elapsed < DAY
					? format.format(-Math.round(elapsed / HOUR), "hour")
					: format.format(-Math.round(elapsed / DAY), "day");
	const absolute = new Intl.DateTimeFormat(locale, {
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	}).format(at);
	return { relative, absolute };
}

export function useSessionText() {
	const { t } = useTranslation("sessions");
	const provider = (value: Provider) => t(`providers.${value}`);
	const state = (value: SessionState) => t(`states.${value}`);
	const error = (value: unknown): string => {
		if (value instanceof SessionsError) {
			const key = `errors.${value.code}`;
			const text = t(key, { detail: value.message, code: value.code });
			return text === key ? t("errors.generic", { code: value.code }) : text;
		}
		return t("errors.generic", { code: String(value).slice(0, 80) });
	};
	const reason = (code: string | undefined) => (code ? error(new SessionsError(code, "")) : "");
	const receipt = (value: SendReceipt, tool: Provider) => {
		const name = provider(tool);
		switch (value.status) {
			case "steered":
				return t("composer.steered", { tool: name });
			case "queuedByProvider":
				return t("composer.queued", { tool: name });
			case "started":
				return t("composer.started", { tool: name });
			case "accepted":
				return t("composer.accepted", { tool: name });
			default:
				return t("composer.unknown");
		}
	};
	return { t, provider, state, error, reason, receipt };
}
