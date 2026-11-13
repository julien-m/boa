/** Visual Preview palette, shared by interactive markers and exported captures. */
import type { CSSProperties } from "react";

export const annotationColors = {
	pin: "#339cff",
	action: "#367bf5",
	draft: "#6b6b6b",
} as const;

export const annotationStyle = {
	"--annotation-blue": annotationColors.pin,
	"--annotation-action": annotationColors.action,
	"--annotation-draft": annotationColors.draft,
} as CSSProperties;
