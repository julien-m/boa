import { X } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { comparisonLabels } from "./image-comparison-labels";
import "./image-comparison.css";

type Dimensions = { width: number; height: number };
type ImageVersion = Dimensions & { src: string; name: string };
const MAX_BYTES = 8 * 1024 * 1024;

/** Both versions use the same physical pixel coordinates and scale. */
export function ImageComparison({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
	const { i18n } = useTranslation();
	const labels = comparisonLabels[i18n.language.startsWith("fr") ? "fr" : "en"];
	const dialog = useRef<HTMLDialogElement>(null);
	const close = useRef<HTMLButtonElement>(null);
	const viewport = useRef<HTMLDivElement>(null);
	const reader = useRef<FileReader | null>(null);
	const [original, setOriginal] = useState<Dimensions | null>(null);
	const [second, setSecond] = useState<ImageVersion | null>(null);
	const [candidate, setCandidate] = useState<{ src: string; name: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [mode, setMode] = useState<"side" | "overlay">("side");
	const [reveal, setReveal] = useState(50);
	const [background, setBackground] = useState("checkerboard");
	const [color, setColor] = useState("#808080");
	const [zoom, setZoom] = useState<number | null>(null);
	const [bounds, setBounds] = useState<Dimensions>({ width: 0, height: 0 });
	useEffect(() => {
		const trigger = document.activeElement;
		const element = dialog.current;
		element?.showModal();
		close.current?.focus({ preventScroll: true });
		return () => {
			reader.current?.abort();
			if (element?.open) element.close();
			if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
		};
	}, []);
	useEffect(() => {
		const element = viewport.current;
		if (!element) return;
		const measure = () =>
			setBounds({
				width: Math.max(0, element.clientWidth - 32),
				height: Math.max(0, element.clientHeight - 64),
			});
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const width = Math.max(original?.width ?? 0, second?.width ?? 0);
	const height = Math.max(original?.height ?? 0, second?.height ?? 0);
	const columns = mode === "side" && second ? 2 : 1;
	const fit =
		width && height && bounds.width && bounds.height
			? Math.min(Math.max(1, bounds.width - (columns - 1) * 16) / (width * columns), bounds.height / height)
			: 1;
	const scale = zoom === null ? fit : zoom / 100;
	const canvasStyle: CSSProperties = {
		backgroundColor:
			background === "custom"
				? color
				: background === "white"
					? "#fff"
					: background === "black"
						? "#000"
						: background === "default"
							? "var(--bg, #17181b)"
							: undefined,
		backgroundImage: background === "checkerboard" ? undefined : "none",
		width: width * scale || undefined,
		height: height * scale || undefined,
	};
	const imageStyle = (dimensions: Dimensions | null): CSSProperties =>
		dimensions ? { width: dimensions.width * scale, height: dimensions.height * scale } : {};
	const choose = (file: File | undefined) => {
		if (!file) return;
		reader.current?.abort();
		reader.current = null;
		setCandidate(null);
		setBusy(false);
		setError(null);
		if (file.size > MAX_BYTES) {
			setError("large");
			return;
		}
		if (
			!/\.(png|jpe?g|gif|webp|svg)$/i.test(file.name) ||
			(file.type && !/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(file.type))
		) {
			setError("invalid");
			return;
		}
		const next = new FileReader();
		reader.current = next;
		setBusy(true);
		next.onload = () => {
			if (reader.current !== next) return;
			if (typeof next.result === "string") setCandidate({ src: next.result, name: file.name });
			else {
				setError("failed");
				setBusy(false);
			}
		};
		next.onerror = () => {
			if (reader.current === next) {
				setError("failed");
				setBusy(false);
			}
		};
		try {
			next.readAsDataURL(file);
		} catch {
			setError("failed");
			setBusy(false);
		}
	};
	return createPortal(
		<dialog
			ref={dialog}
			className="image-comparison"
			aria-label={labels.title}
			onKeyDown={(event) => event.stopPropagation()}
			onCancel={(event) => {
				event.stopPropagation();
				event.preventDefault();
				onClose();
			}}
			onClose={(event) => {
				if (!event.currentTarget.open) onClose();
			}}
		>
			<header>
				<strong>{labels.title}</strong>
				<button
					ref={close}
					type="button"
					className="quiet-button"
					aria-label={labels.close}
					data-hint={labels.close}
					aria-keyshortcuts="Escape"
					onClick={onClose}
				>
					<X size={16} />
				</button>
			</header>
			<div className="image-comparison-toolbar">
				<label className="image-comparison-picker">
					{labels.choose}
					<input
						type="file"
						aria-label={labels.choose}
						accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,.png,.jpg,.jpeg,.gif,.webp,.svg"
						onChange={(event) => {
							choose(event.currentTarget.files?.[0]);
							event.currentTarget.value = "";
						}}
					/>
				</label>
				<button
					type="button"
					className="quiet-button"
					aria-pressed={mode === "side"}
					onClick={() => setMode("side")}
				>
					{labels.side}
				</button>
				<button
					type="button"
					className="quiet-button"
					aria-pressed={mode === "overlay"}
					onClick={() => setMode("overlay")}
				>
					{labels.overlay}
				</button>
				<label>
					{labels.zoom}
					<input
						type="range"
						aria-label={labels.zoom}
						min="25"
						max="1600"
						step="5"
						value={Math.min(1600, Math.max(25, Math.round(scale * 100)))}
						onChange={(event) => setZoom(Number(event.currentTarget.value))}
					/>
				</label>
				<button
					type="button"
					className="quiet-button"
					aria-label={labels.actual}
					data-hint={labels.actual}
					onClick={() => setZoom(100)}
				>
					{Math.round(scale * 100)} %
				</button>
				<button
					type="button"
					className="quiet-button"
					aria-pressed={zoom === null}
					onClick={() => setZoom(null)}
				>
					{labels.fit}
				</button>
				<label>
					{labels.background}
					<select
						aria-label={labels.background}
						value={background}
						onChange={(event) => setBackground(event.currentTarget.value)}
					>
						{(["default", "checkerboard", "white", "black", "custom"] as const).map((value) => (
							<option key={value} value={value}>
								{labels[value]}
							</option>
						))}
					</select>
				</label>
				{background === "custom" && (
					<input
						type="color"
						aria-label={labels.custom}
						value={color}
						onChange={(event) => setColor(event.currentTarget.value)}
					/>
				)}
				{mode === "overlay" && second && (
					<label>
						{labels.reveal}
						<input
							type="range"
							min="0"
							max="100"
							value={reveal}
							aria-label={labels.reveal}
							onChange={(event) => setReveal(Number(event.currentTarget.value))}
						/>
						<output>{reveal} %</output>
					</label>
				)}
			</div>
			{error && <p role="alert">{labels[error as "large" | "invalid" | "failed"]}</p>}
			{busy && <p role="status">{labels.loading}</p>}
			{!second && !busy && <p>{labels.empty}</p>}
			{candidate && (
				<img
					key={candidate.src}
					className="image-comparison-decoder"
					src={candidate.src}
					alt=""
					aria-hidden="true"
					onLoad={(event) => {
						const { naturalWidth, naturalHeight } = event.currentTarget;
						if (!naturalWidth || !naturalHeight) {
							setError("failed");
						} else setSecond({ ...candidate, width: naturalWidth, height: naturalHeight });
						setCandidate(null);
						setBusy(false);
					}}
					onError={() => {
						setCandidate(null);
						setBusy(false);
						setError("failed");
					}}
				/>
			)}
			<div ref={viewport} className="image-comparison-viewport">
				<div className={`image-comparison-images ${mode}`}>
					<figure>
						<figcaption>
							{labels.original}: {alt}
							{original && ` · ${original.width} × ${original.height} px`}
						</figcaption>
						<div className="image-comparison-canvas" style={canvasStyle}>
							<img
								src={src}
								alt={alt}
								style={imageStyle(original)}
								onLoad={(event) =>
									setOriginal({
										width: event.currentTarget.naturalWidth,
										height: event.currentTarget.naturalHeight,
									})
								}
								onError={() => setError("failed")}
							/>
							{second && mode === "overlay" && (
								<div
									className="image-comparison-overlay"
									style={{ clipPath: `inset(0 ${100 - reveal}% 0 0)` }}
								>
									<img src={second.src} alt={second.name} style={imageStyle(second)} />
									<span className="image-comparison-divider" style={{ left: `${reveal}%` }} />
								</div>
							)}
						</div>
					</figure>
					{second && mode === "side" && (
						<figure>
							<figcaption>
								{labels.second}: {second.name} · {second.width} × {second.height} px
							</figcaption>
							<div className="image-comparison-canvas" style={canvasStyle}>
								<img src={second.src} alt={second.name} style={imageStyle(second)} />
							</div>
						</figure>
					)}
				</div>
			</div>
		</dialog>,
		document.body,
	);
}
