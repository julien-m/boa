import { RotateCcw, X } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { comparisonLabels } from "./image-comparison-labels";
import "./image-comparison.css";

type Dimensions = { width: number; height: number };
type ImageVersion = Dimensions & { src: string; name: string; size: number };

/** Both versions use the same physical pixel coordinates and scale. */
export function ImageComparison({
	src,
	alt,
	onClose,
	fileBytes,
	location,
}: {
	src: string;
	alt: string;
	onClose: () => void;
	fileBytes?: number;
	location?: { project: string; path: string };
}) {
	const { i18n } = useTranslation();
	const labels = comparisonLabels[i18n.language.startsWith("fr") ? "fr" : "en"];
	const dialog = useRef<HTMLDialogElement>(null);
	const close = useRef<HTMLButtonElement>(null);
	const viewport = useRef<HTMLDivElement>(null);
	const request = useRef(0);
	const [original, setOriginal] = useState<Dimensions | null>(null);
	const [second, setSecond] = useState<ImageVersion | null>(null);
	const [candidate, setCandidate] = useState<{ src: string; name: string; size: number } | null>(null);
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
			request.current += 1;
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
	const choose = async () => {
		const current = ++request.current;
		setCandidate(null);
		setBusy(true);
		setError(null);
		try {
			const slash = location?.path.lastIndexOf("/") ?? -1;
			const directory = slash >= 0 ? location?.path.slice(0, slash) : "";
			const result = await api.chooseComparisonImage(location?.project, location ? directory : undefined);
			if (current !== request.current) return;
			if (result) setCandidate({ src: result.dataUrl, name: result.name, size: result.size });
			else setBusy(false);
		} catch (cause) {
			if (current !== request.current) return;
			setError(String(cause));
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
				<button
					type="button"
					className="quiet-button image-comparison-picker"
					disabled={busy}
					onClick={choose}
				>
					{labels.choose}
				</button>
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
				<button
					type="button"
					className="icon-button"
					aria-label={labels.resetBackground}
					disabled={background === "default"}
					onClick={() => setBackground("default")}
				>
					<RotateCcw size={14} />
				</button>
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
			{error && <p role="alert">{error === "failed" ? labels.failed : error}</p>}
			{busy && <p role="status">{labels.loading}</p>}
			{!second && !busy && <p>{labels.empty}</p>}
			{candidate && (
				<img
					referrerPolicy="no-referrer"
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
							{fileBytes !== undefined &&
								` · ${new Intl.NumberFormat(i18n.language).format(fileBytes)} ${labels.bytes}`}
						</figcaption>
						<div className="image-comparison-canvas" style={canvasStyle}>
							<img
								referrerPolicy="no-referrer"
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
								<>
									<div
										className="image-comparison-overlay"
										style={{ clipPath: `inset(0 ${100 - reveal}% 0 0)` }}
									>
										<img
											referrerPolicy="no-referrer"
											src={second.src}
											alt={second.name}
											style={imageStyle(second)}
										/>
									</div>
									<span className="image-comparison-divider" style={{ left: `${reveal}%` }} />
								</>
							)}
						</div>
					</figure>
					{second && mode === "side" && (
						<figure>
							<figcaption>
								{labels.second}: {second.name} · {second.width} × {second.height} px ·{" "}
								{new Intl.NumberFormat(i18n.language).format(second.size)} {labels.bytes}
							</figcaption>
							<div className="image-comparison-canvas" style={canvasStyle}>
								<img
									referrerPolicy="no-referrer"
									src={second.src}
									alt={second.name}
									style={imageStyle(second)}
								/>
							</div>
						</figure>
					)}
				</div>
			</div>
		</dialog>,
		document.body,
	);
}
