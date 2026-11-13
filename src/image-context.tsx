/** Blue, selectable image pins and an adjacent composer; source coordinates stay normalized. */
import { Check, MessageSquarePlus, Trash2, X } from "lucide-react";
import {
	type PointerEvent,
	type RefObject,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { annotationStyle } from "./annotation-style";
import { useContextCollection } from "./context-collection";
import { imageSourceKey, snapshotImage } from "./context-collection-images";
import { useCollectionLabels } from "./context-collection-labels";
import {
	type Annotation,
	collectionLimits,
	type ImageItem,
	isAnnotationDraft,
	pointInImage,
} from "./context-collection-model";

export function ImageMarkers({
	annotations,
	selected,
	onSelect,
	onMove,
}: {
	annotations: Annotation[];
	selected?: string | null;
	onSelect?: (id: string) => void;
	onMove?: (id: string, clientX: number, clientY: number) => void;
}) {
	const l = useCollectionLabels();
	const drag = useRef<{ id: string; pointer: number; x: number; y: number; moved: boolean } | null>(null);
	const suppressClick = useRef(false);
	const resetPreview = (button: HTMLButtonElement) => {
		button.style.removeProperty("--annotation-drag-x");
		button.style.removeProperty("--annotation-drag-y");
	};
	const handlePointerDown = (event: PointerEvent<HTMLButtonElement>, id: string) => {
		if (!onMove || event.button !== 0) return;
		event.stopPropagation();
		event.preventDefault();
		suppressClick.current = false;
		drag.current = { id, pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
		event.currentTarget.setPointerCapture?.(event.pointerId);
	};
	const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
		const current = drag.current;
		if (!current || current.pointer !== event.pointerId) return;
		// A small slop separates an intentional drag from a click on the marker.
		if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 4) return;
		current.moved = true;
		// Preview in CSS; commit the collected source position once on release, not per pointer event.
		event.currentTarget.style.setProperty("--annotation-drag-x", `${event.clientX - current.x}px`);
		event.currentTarget.style.setProperty("--annotation-drag-y", `${event.clientY - current.y}px`);
	};
	const handlePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
		const current = drag.current;
		if (!current || current.pointer !== event.pointerId) return;
		suppressClick.current = current.moved;
		drag.current = null;
		resetPreview(event.currentTarget);
		if (event.currentTarget.hasPointerCapture?.(event.pointerId))
			event.currentTarget.releasePointerCapture(event.pointerId);
		if (current.moved) onMove?.(current.id, event.clientX, event.clientY);
	};
	const handlePointerCancel = (event: PointerEvent<HTMLButtonElement>) => {
		drag.current = null;
		suppressClick.current = false;
		resetPreview(event.currentTarget);
	};
	return (
		<span className="image-context-markers" style={annotationStyle} aria-hidden={onSelect ? undefined : true}>
			{annotations.map((annotation, index) => {
				if (!annotation.point) return null;
				const style = { left: `${annotation.point.x * 100}%`, top: `${annotation.point.y * 100}%` };
				const className = `image-context-marker${isAnnotationDraft(annotation) ? " draft" : ""}${selected === annotation.id ? " selected" : ""}`;
				return onSelect ? (
					<button
						key={annotation.id}
						type="button"
						className={className}
						style={style}
						aria-label={`${l.annotation} ${index + 1}`}
						data-hint={annotation.message || l.addComment}
						onPointerDown={(event) => handlePointerDown(event, annotation.id)}
						onPointerMove={handlePointerMove}
						onPointerUp={handlePointerUp}
						onPointerCancel={handlePointerCancel}
						onClick={(event) => {
							event.stopPropagation();
							if (suppressClick.current) {
								suppressClick.current = false;
								return;
							}
							onSelect(annotation.id);
						}}
					>
						{index + 1}
					</button>
				) : (
					<span key={annotation.id} className={className} style={style}>
						{index + 1}
					</span>
				);
			})}
		</span>
	);
}

function ImageComment({
	image,
	annotation,
	number,
	saving,
	error,
	onMessage,
	onDone,
	onRemove,
	onClose,
}: {
	image: RefObject<HTMLImageElement | null>;
	annotation: Annotation;
	number: number;
	saving: boolean;
	error: string;
	onMessage: (value: string) => void;
	onDone: () => void;
	onRemove: () => void;
	onClose: () => void;
}) {
	const l = useCollectionLabels();
	const id = useId();
	const composer = useRef<HTMLFormElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const [position, setPosition] = useState({ left: 16, top: 16, ready: false });
	useLayoutEffect(() => {
		const source = image.current;
		const element = composer.current;
		if (!source || !element || !annotation.point) return;
		const place = () => {
			const bounds = source.getBoundingClientRect();
			const width = element.getBoundingClientRect().width;
			const height = element.getBoundingClientRect().height;
			const x = bounds.left + annotation.point!.x * bounds.width;
			const y = bounds.top + annotation.point!.y * bounds.height;
			const preferred = x + 20 + width <= window.innerWidth - 8 ? x + 20 : x - width - 20;
			const left = Math.max(8, Math.min(preferred, window.innerWidth - width - 8));
			const top = Math.max(8, Math.min(y - height / 2, window.innerHeight - height - 8));
			setPosition((current) =>
				current.ready && current.left === left && current.top === top ? current : { left, top, ready: true },
			);
		};
		place();
		const resize = new ResizeObserver(place);
		resize.observe(source);
		resize.observe(element);
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => {
			resize.disconnect();
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [image, annotation.id, annotation.point?.x, annotation.point?.y]);
	useEffect(() => {
		input.current?.focus({ preventScroll: true });
	}, [annotation.id]);
	return createPortal(
		<form
			ref={composer}
			className="image-note image-context-form"
			data-testid="image-context-form"
			role="dialog"
			aria-label={`${l.annotation} ${number}`}
			style={{
				...annotationStyle,
				left: position.left,
				top: position.top,
				visibility: position.ready ? "visible" : "hidden",
			}}
			onSubmit={(event) => {
				event.preventDefault();
				onDone();
			}}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.key === "Escape") {
					event.preventDefault();
					onClose();
				}
				if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
			}}
		>
			<div className="image-note-row">
				<label className="image-note-label" htmlFor={`${id}-message`}>{`${l.annotation} ${number}`}</label>
				<input
					ref={input}
					id={`${id}-message`}
					type="text"
					data-testid="image-context-message"
					aria-label={l.commentInput}
					placeholder={l.addComment}
					value={annotation.message}
					maxLength={collectionLimits.message}
					onChange={(event) => onMessage(event.target.value)}
				/>
				<button
					type="button"
					className="icon-button"
					aria-label={l.removeAnnotation}
					data-testid="image-context-remove"
					onClick={onRemove}
				>
					<Trash2 size={15} />
				</button>
				<button
					type="submit"
					className="icon-button image-note-done"
					aria-label={l.done}
					title={l.done}
					data-testid="image-context-add"
					disabled={!annotation.message.trim()}
				>
					<Check size={17} />
				</button>
				<button type="button" className="icon-button" aria-label={l.closeComment} onClick={onClose}>
					<X size={14} />
				</button>
			</div>
			{error ? (
				<p role="alert" className="collection-error">
					{error}
				</p>
			) : saving ? (
				<small className="image-note-status">{l.saving}</small>
			) : null}
		</form>,
		image.current?.closest("dialog") ?? document.body,
	);
}

export function useImageContext({
	src,
	location,
	image,
	ready,
}: {
	src: string;
	location?: { project: string; path: string };
	image: RefObject<HTMLImageElement | null>;
	ready: boolean;
}) {
	const c = useContextCollection();
	const l = useCollectionLabels();
	const [selected, setSelected] = useState<string | null>(null);
	const [sourceKey, setSourceKey] = useState("");
	const [error, setError] = useState("");
	const enabled = !!c?.annotating && !!location;
	useEffect(() => {
		let cancelled = false;
		setSourceKey("");
		setSelected(null);
		setError("");
		if (c && location)
			void imageSourceKey(src)
				.then((key) => {
					if (!cancelled) setSourceKey(key);
				})
				.catch((reason) => {
					if (!cancelled) setError(String(reason));
				});
		return () => {
			cancelled = true;
		};
	}, [src, location?.project, location?.path, !!c]);
	const existing = c?.draft.items.find(
		(item): item is ImageItem =>
			item.kind === "image" &&
			item.project === location?.project &&
			item.path === location?.path &&
			item.sourceKey === sourceKey,
	);
	const annotation = existing?.annotations.find((item) => item.id === selected);
	const mutate = (operation: () => void): boolean => {
		try {
			operation();
			setError("");
			return true;
		} catch (reason) {
			setError(String(reason));
			return false;
		}
	};
	const patch = (update: (a: Annotation) => Annotation): boolean => {
		if (!c || !existing || !selected) return false;
		return mutate(() =>
			c.patchItem(existing.id, (item) =>
				item.kind === "image"
					? { ...item, annotations: item.annotations.map((a) => (a.id === selected ? update(a) : a)) }
					: item,
			),
		);
	};
	const close = () => {
		setSelected(null);
		image.current?.closest<HTMLElement>(".image-viewport")?.focus({ preventScroll: true });
	};
	const remove = () => {
		if (!c || !existing || !selected) return;
		mutate(() => {
			c.change((draft) => ({
				...draft,
				items: draft.items.flatMap((item) => {
					if (item.id !== existing.id || item.kind !== "image") return [item];
					const annotations = item.annotations.filter((a) => a.id !== selected);
					return annotations.length ? [{ ...item, annotations }] : [];
				}),
			}));
			close();
		});
	};
	const onPoint = (event: PointerEvent<HTMLImageElement>) => {
		if (!enabled || !c?.ready || !location || !image.current || !sourceKey || !ready || event.button !== 0)
			return;
		event.preventDefault();
		const point = pointInImage(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect());
		if (!point) return;
		mutate(() => {
			const blank = existing?.annotations.find((entry) => !entry.message.trim());
			if (blank && existing) {
				c.patchItem(existing.id, (item) =>
					item.kind === "image"
						? {
								...item,
								annotations: item.annotations.map((a) =>
									a.id === blank.id ? { ...a, point, confirmed: false } : a,
								),
							}
						: item,
				);
				setSelected(blank.id);
				return;
			}
			const snapshot = existing
				? { dataUrl: existing.dataUrl, width: existing.width, height: existing.height }
				: snapshotImage(image.current!);
			const id = crypto.randomUUID();
			c.addImage({ ...snapshot, ...location, sourceKey }, { id, message: "", point, confirmed: false });
			setSelected(id);
		});
	};
	if (!c || !location) return { actions: null, overlay: null, form: null, onPoint, enabled: false };
	return {
		enabled,
		onPoint,
		form: null,
		actions: (
			<>
				<button
					type="button"
					className="quiet-button"
					data-testid="image-annotate"
					disabled={!ready || !c.ready || !sourceKey}
					aria-pressed={enabled}
					onClick={() => {
						c.setAnnotating(!enabled);
						if (enabled) close();
					}}
				>
					<MessageSquarePlus size={14} />
					{l.annotate}
				</button>
				{(enabled || existing) && (
					<button type="button" className="quiet-button" onClick={c.show}>
						{l.review} · {c.draft.items.length}
					</button>
				)}
				{error && !annotation && (
					<small role="alert" className="collection-error">
						{error}
					</small>
				)}
			</>
		),
		overlay: (
			<>
				<ImageMarkers
					annotations={existing?.annotations ?? []}
					selected={selected}
					onMove={(id, clientX, clientY) => {
						if (!existing || !image.current) return;
						const point = pointInImage(clientX, clientY, image.current.getBoundingClientRect());
						if (!point) return;
						mutate(() =>
							c.patchItem(existing.id, (item) =>
								item.kind === "image"
									? { ...item, annotations: item.annotations.map((a) => (a.id === id ? { ...a, point } : a)) }
									: item,
							),
						);
					}}
					onSelect={(id) => {
						setSelected(id);
						setError("");
					}}
				/>
				{annotation?.point && (
					<ImageComment
						image={image}
						annotation={annotation}
						number={existing!.annotations.indexOf(annotation) + 1}
						saving={c.saving}
						error={error || (c.error ? l.unsaved : "")}
						onMessage={(message) => patch((a) => ({ ...a, message, confirmed: false }))}
						onDone={() => {
							if (!annotation.message.trim()) return;
							if (patch((a) => ({ ...a, message: a.message.trim(), confirmed: true }))) close();
						}}
						onRemove={remove}
						onClose={close}
					/>
				)}
			</>
		),
	};
}
