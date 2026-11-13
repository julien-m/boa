/** Mouse/keyboard splitter; pointer motion updates CSS without rerendering the editor. */
import { type RefObject, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export function PanelResizer({
	container,
	vertical = false,
	panel = "git",
}: {
	container: RefObject<HTMLDivElement | null>;
	vertical?: boolean;
	panel?: "git" | "tree" | "history" | "repositories";
}) {
	const { t } = useTranslation("workspace");
	const configuration = {
		git: {
			storageKey: vertical ? "boa-git-width" : "boa-git-height",
			property: vertical ? "--git-list-size" : "--git-size",
			minimum: vertical ? 20 : 18,
			maximum: vertical ? 70 : 75,
			initial: vertical ? 42 : 39,
			label: vertical ? "width" : "height",
			testId: vertical ? "git-width-resizer" : "git-resizer",
		},
		tree: {
			storageKey: "boa-tree-width",
			property: "--file-tree-size",
			minimum: 12,
			maximum: 70,
			initial: 24,
			label: "treeWidth",
			testId: "file-tree-resizer",
		},
		history: {
			storageKey: `boa-history-${vertical ? "width" : "height"}`,
			property: "--history-list-size",
			minimum: vertical ? 20 : 18,
			maximum: 80,
			initial: 55,
			label: "history",
			testId: "history-resizer",
		},
		repositories: {
			storageKey: "boa-repository-width",
			property: "--repository-list-size",
			minimum: 12,
			maximum: 40,
			initial: 18,
			label: "repositories",
			testId: "repository-resizer",
		},
	}[panel];
	const { storageKey, property, minimum, maximum } = configuration;
	const history = panel === "history";
	const [value, setValue] = useState(() => {
		const saved = Number(localStorage.getItem(storageKey));
		return saved >= minimum && saved <= maximum ? saved : configuration.initial;
	});
	const current = useRef(value);
	const update = (ratio: number): void => {
		current.current = Math.max(minimum, Math.min(maximum, ratio));
		container.current?.style.setProperty(property, `${current.current}%`);
	};
	const persist = (): void => {
		localStorage.setItem(storageKey, String(current.current));
		setValue(current.current);
	};
	useEffect(() => {
		container.current?.style.setProperty(property, `${value}%`);
	}, [container, value, property]);
	return (
		<button
			type="button"
			role="separator"
			aria-orientation={vertical ? "vertical" : "horizontal"}
			aria-valuenow={Math.round(value)}
			aria-valuemin={minimum}
			aria-valuemax={maximum}
			aria-label={t(`resizer.${configuration.label}`)}
			data-hint={vertical ? t("resizer.widthHint") : t("resizer.heightHint")}
			data-testid={configuration.testId}
			className={vertical ? "git-resizer vertical" : "git-resizer"}
			onPointerDown={(event) => {
				event.preventDefault();
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={(event) => {
				if (!event.currentTarget.hasPointerCapture(event.pointerId) || !container.current) return;
				const bounds = container.current.getBoundingClientRect();
				update(
					vertical
						? ((event.clientX - bounds.left) / bounds.width) * 100
						: ((history ? event.clientY - bounds.top : bounds.bottom - event.clientY) / bounds.height) * 100,
				);
			}}
			onPointerUp={(event) => {
				if (event.currentTarget.hasPointerCapture(event.pointerId))
					event.currentTarget.releasePointerCapture(event.pointerId);
				persist();
			}}
			onPointerCancel={persist}
			onKeyDown={(event) => {
				if (
					vertical
						? event.key === "ArrowLeft" || event.key === "ArrowRight"
						: event.key === "ArrowUp" || event.key === "ArrowDown"
				) {
					event.preventDefault();
					update(
						current.current +
							(event.key === (vertical ? "ArrowRight" : history ? "ArrowDown" : "ArrowUp") ? 3 : -3),
					);
					persist();
				}
			}}
		>
			<span />
		</button>
	);
}
