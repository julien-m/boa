/** Mouse/keyboard splitter; pointer motion updates CSS without rerendering the editor. */
import { type RefObject, useEffect, useRef, useState } from "react";

export function PanelResizer({
	container,
	vertical = false,
}: {
	container: RefObject<HTMLDivElement | null>;
	vertical?: boolean;
}) {
	const storageKey = vertical ? "boa-git-width" : "boa-git-height";
	const property = vertical ? "--git-list-size" : "--git-size";
	const minimum = vertical ? 20 : 18;
	const maximum = vertical ? 70 : 75;
	const [value, setValue] = useState(() => {
		const saved = Number(localStorage.getItem(storageKey));
		return saved >= minimum && saved <= maximum ? saved : vertical ? 42 : 39;
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
			aria-label={vertical ? "Largeur de la liste des changements" : "Hauteur du panneau Git"}
			title={
				vertical
					? "Glisser pour redimensionner · flèches gauche/droite au clavier"
					: "Glisser pour redimensionner Git · flèches haut/bas au clavier"
			}
			data-testid={vertical ? "git-width-resizer" : "git-resizer"}
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
						: ((bounds.bottom - event.clientY) / bounds.height) * 100,
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
					update(current.current + (event.key === (vertical ? "ArrowRight" : "ArrowUp") ? 3 : -3));
					persist();
				}
			}}
		>
			<span />
		</button>
	);
}
