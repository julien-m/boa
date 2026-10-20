/** Shared visual zoom; 100% uses intrinsic CSS pixels, independently of the viewport. */

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Columns2, Grid2X2, Minus, Pipette, Plus, RotateCcw } from "lucide-react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { consumeImageAction } from "./image-actions";
import { ImageComparison } from "./image-comparison";

type ImageLocation = { project: string; path: string };
type ImageBackground = { mode: "default" | "checkerboard" | "white" | "black" | "custom"; color: string };
const defaultBackground: ImageBackground = { mode: "default", color: "#ffffff" };
export function imageByteSize(src: string): number | undefined {
	if (!src.startsWith("data:")) return;
	const comma = src.indexOf(",");
	if (comma < 0) return;
	if (src.slice(0, comma).endsWith(";base64"))
		return (
			Math.floor(((src.length - comma - 1) * 3) / 4) - (src.endsWith("==") ? 2 : src.endsWith("=") ? 1 : 0)
		);
	try {
		return new TextEncoder().encode(decodeURIComponent(src.slice(comma + 1))).length;
	} catch {
		return;
	}
}
interface ZoomSession {
	zoom: number | null;
	setZoom: (value: number | null) => void;
	onScale: (percent: number) => void;
	background: ImageBackground;
	setBackground: (value: ImageBackground) => void;
	grid: boolean;
	setGrid: (value: boolean) => void;
}
const ImageZoomContext = createContext<ZoomSession | null>(null);
/** Retains even the precise ratio computed by Fit before browsing another image. */
export function useImageZoomSession() {
	const [zoom, setZoom] = useState<number | null>(null);
	const [background, setBackground] = useState(defaultBackground);
	const [grid, setGrid] = useState(false);
	const measured = useRef(100);
	const onScale = useCallback((percent: number) => {
		measured.current = percent;
	}, []);
	const retain = () => setZoom((current) => current ?? measured.current);
	const state = useMemo(
		() => ({ zoom, setZoom, onScale, background, setBackground, grid, setGrid }),
		[zoom, onScale, background, grid],
	);
	return { state, retain };
}
/** Shares zoom/Fit across portals and image changes when supplied a browsing session. */
export function ImageZoom({ children, session }: { children: ReactNode; session?: ZoomSession }) {
	const local = useImageZoomSession();
	return <ImageZoomContext.Provider value={session ?? local.state}>{children}</ImageZoomContext.Provider>;
}

export function ZoomControls({
	percent,
	fitting,
	ready,
	onZoom,
	onFit,
	actions,
}: {
	percent: number;
	fitting: boolean;
	ready: boolean;
	onZoom: (percent: number) => void;
	onFit: () => void;
	actions?: ReactNode;
}) {
	const { t } = useTranslation("workspace");
	const change = (value: number) => onZoom(Math.max(25, Math.min(1600, value)));
	return (
		<div className="visual-zoom" role="group" aria-label={t("zoom.controls")}>
			<button
				type="button"
				className="icon-button"
				aria-label={t("zoom.out")}
				disabled={!ready || percent <= 25}
				onClick={() => change(percent - 25)}
			>
				<Minus size={13} />
			</button>
			<input
				type="range"
				min={25}
				max={1600}
				step={5}
				value={Math.max(25, Math.min(1600, percent))}
				disabled={!ready}
				aria-label={t("zoom.level")}
				aria-valuetext={fitting ? t("zoom.fitted", { percent }) : `${percent} %`}
				onChange={(e) => change(Number(e.target.value))}
			/>
			<button
				type="button"
				className="icon-button"
				aria-label={t("zoom.in")}
				disabled={!ready || percent >= 1600}
				onClick={() => change(percent + 25)}
			>
				<Plus size={13} />
			</button>
			<button
				type="button"
				className="quiet-button visual-zoom-value"
				data-hint={t("zoom.actual")}
				aria-label={t("zoom.actual")}
				disabled={!ready}
				onClick={() => change(100)}
			>
				{ready ? `${percent} %` : "—"}
			</button>
			<button
				type="button"
				className="quiet-button"
				data-hint={t("zoom.fitHint")}
				aria-pressed={fitting}
				disabled={!ready}
				onClick={onFit}
			>
				{t("zoom.fit")}
			</button>
			{actions}
		</div>
	);
}

function ImageContent({
	src,
	alt,
	onError,
	actions,
	fileBytes,
	location,
}: {
	src: string;
	alt: string;
	onError: () => void;
	actions?: ReactNode;
	fileBytes?: number;
	location?: ImageLocation;
}) {
	const { t, i18n } = useTranslation("workspace");
	const [failed, setFailed] = useState(false);
	const viewport = useRef<HTMLDivElement>(null);
	const container = useRef<HTMLDivElement>(null);
	const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
	const [bounds, setBounds] = useState({ width: 0, height: 0 });
	const [localZoom, setLocalZoom] = useState<number | null>(null);
	const sharedZoom = useContext(ImageZoomContext);
	const [localBackground, setLocalBackground] = useState(defaultBackground);
	const background = sharedZoom?.background ?? localBackground;
	const setBackground = sharedZoom?.setBackground ?? setLocalBackground;
	const [localGrid, setLocalGrid] = useState(false);
	const grid = sharedZoom?.grid ?? localGrid;
	const setGrid = sharedZoom?.setGrid ?? setLocalGrid;
	const [picking, setPicking] = useState(false);
	const [comparing, setComparing] = useState(false);
	useEffect(() => {
		if (!natural || !location) return;
		const consume = () => {
			const action = consumeImageAction(location.project, location.path);
			if (action === "compare") setComparing(true);
			if (action === "fullscreen")
				container.current?.querySelector<HTMLButtonElement>("[data-image-fullscreen]")?.click();
		};
		consume();
		window.addEventListener("boa:image-action", consume);
		return () => window.removeEventListener("boa:image-action", consume);
	}, [natural, location?.project, location?.path]);
	const [sample, setSample] = useState("");
	const bytes = fileBytes ?? imageByteSize(src);
	const unit = bytes !== undefined && bytes >= 1048576 ? 2 : bytes !== undefined && bytes >= 1024 ? 1 : 0;
	const weight =
		bytes === undefined
			? t("imageTools.unknownSize")
			: `${new Intl.NumberFormat(i18n.language, { maximumFractionDigits: unit ? 1 : 0 }).format(bytes / 1024 ** unit)} ${t(["imageTools.bytes", "imageTools.kib", "imageTools.mib"][unit])}`;
	const backgroundStyle =
		background.mode === "checkerboard"
			? {
					backgroundColor: "#fff",
					backgroundImage: "conic-gradient(#bbb 25%, #fff 0 50%, #bbb 0 75%, #fff 0)",
					backgroundSize: "16px 16px",
				}
			: background.mode === "default"
				? undefined
				: {
						backgroundColor:
							background.mode === "custom" ? background.color : background.mode === "black" ? "#000" : "#fff",
					};
	const pick = async (event: React.PointerEvent<HTMLImageElement>) => {
		if (!picking || !natural) return;
		event.preventDefault();
		setPicking(false);
		try {
			const img = event.currentTarget,
				bounds = img.getBoundingClientRect();
			if (!bounds.width || !bounds.height) throw new Error("Image not ready");
			const x = Math.max(
				0,
				Math.min(
					natural.width - 1,
					Math.floor(((event.clientX - bounds.left) * natural.width) / bounds.width),
				),
			);
			const y = Math.max(
				0,
				Math.min(
					natural.height - 1,
					Math.floor(((event.clientY - bounds.top) * natural.height) / bounds.height),
				),
			);
			const canvas = document.createElement("canvas");
			canvas.width = 1;
			canvas.height = 1;
			const context = canvas.getContext("2d", { willReadFrequently: true });
			if (!context) throw new Error("Canvas unavailable");
			context.imageSmoothingEnabled = false;
			context.drawImage(img, x, y, 1, 1, 0, 0, 1, 1);
			const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
			const color = `#${[r, g, b, ...(alpha < 255 ? [alpha] : [])]
				.map((value) => value.toString(16).padStart(2, "0"))
				.join("")
				.toUpperCase()}`;
			const rgba = `rgba(${r}, ${g}, ${b}, ${Math.round((alpha / 255) * 1000) / 1000})`;
			try {
				await writeText(color);
				setSample(t("imageTools.copied", { color, rgba }));
			} catch {
				setSample(t("imageTools.copyFailed", { color, rgba }));
			}
		} catch {
			setSample(t("imageTools.sampleUnavailable"));
		}
	};
	const zoom = sharedZoom ? sharedZoom.zoom : localZoom;
	const setZoom = sharedZoom?.setZoom ?? setLocalZoom;
	useLayoutEffect(() => {
		const element = viewport.current;
		if (!element) return;
		const measure = () => {
			const width = Math.max(0, element.clientWidth - 32),
				height = Math.max(0, element.clientHeight - 32);
			setBounds((previous) =>
				previous.width === width && previous.height === height ? previous : { width, height },
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const fitting = zoom === null;
	const scale =
		zoom !== null
			? zoom / 100
			: natural
				? Math.min(
						bounds.width > 0 ? bounds.width / natural.width : 1,
						bounds.height > 0 ? bounds.height / natural.height : 1,
					)
				: 1;
	const percent = Math.max(1, Math.round(scale * 100));
	useLayoutEffect(() => {
		if (natural && bounds.width > 0 && bounds.height > 0) sharedZoom?.onScale(scale * 100);
	}, [natural, bounds, sharedZoom, scale]);
	const resetScroll = () => {
		if (viewport.current) {
			viewport.current.scrollTop = 0;
			viewport.current.scrollLeft = 0;
		}
	};
	if (failed)
		return (
			<div className="image-viewer file-asset-message" role="status">
				{t("asset.imageFailed")}
			</div>
		);
	return (
		<div ref={container} className="image-viewer" data-testid="image-viewer">
			<ZoomControls
				actions={
					<>
						{actions}
						<select
							className="image-background-select"
							aria-label={t("imageTools.background")}
							value={background.mode}
							onChange={(event) =>
								setBackground({ ...background, mode: event.target.value as ImageBackground["mode"] })
							}
						>
							{(["default", "checkerboard", "white", "black", "custom"] as const).map((mode) => (
								<option key={mode} value={mode}>
									{t(`imageTools.${mode}`)}
								</option>
							))}
						</select>
						{background.mode === "custom" && (
							<input
								type="color"
								className="image-background-color"
								aria-label={t("imageTools.custom")}
								value={background.color}
								onChange={(event) => setBackground({ ...background, color: event.target.value })}
							/>
						)}
						<button
							type="button"
							className="icon-button"
							aria-label={t("imageTools.resetBackground")}
							disabled={background.mode === "default"}
							onClick={() => setBackground(defaultBackground)}
						>
							<RotateCcw size={13} />
						</button>
						<button
							type="button"
							className="icon-button"
							aria-label={t("imageTools.pipette")}
							aria-pressed={picking}
							disabled={!natural}
							onClick={() => {
								setPicking(!picking);
								setSample("");
							}}
						>
							<Pipette size={14} />
						</button>
						<button
							type="button"
							className="icon-button"
							aria-label={t("imageTools.grid")}
							data-hint={t("imageTools.gridHint")}
							aria-pressed={grid}
							disabled={!natural || scale < 4}
							onClick={() => setGrid(!grid)}
						>
							<Grid2X2 size={14} />
						</button>
						<button
							type="button"
							className="icon-button"
							aria-label={t("imageTools.compare")}
							disabled={!natural}
							onClick={() => setComparing(true)}
						>
							<Columns2 size={14} />
						</button>
					</>
				}
				percent={percent}
				fitting={fitting}
				ready={!!natural}
				onZoom={(value) => setZoom(value)}
				onFit={() => {
					setZoom(null);
					resetScroll();
				}}
			/>
			{natural && (
				<small className="image-facts">
					{natural.width} × {natural.height} px · {weight}
				</small>
			)}
			{(picking || sample) && (
				<small className="image-sample" role="status">
					{picking ? t("imageTools.pickHint") : sample}
				</small>
			)}
			<div
				ref={viewport}
				className="file-image-stage image-viewport"
				role="region"
				aria-label={alt}
				tabIndex={0}
			>
				<div className="image-canvas" style={backgroundStyle}>
					<div className="image-pixel-surface">
						<img
							src={src}
							alt={alt}
							referrerPolicy="no-referrer"
							draggable={false}
							className={picking ? "picking" : undefined}
							onPointerDown={(event) => {
								void pick(event);
							}}
							style={
								natural
									? {
											width: natural.width * scale,
											height: natural.height * scale,
											imageRendering: grid && scale >= 4 ? "pixelated" : undefined,
										}
									: undefined
							}
							onLoad={(event) => {
								const { naturalWidth, naturalHeight } = event.currentTarget;
								if (naturalWidth && naturalHeight) setNatural({ width: naturalWidth, height: naturalHeight });
							}}
							onError={() => {
								setFailed(true);
								onError();
							}}
						/>
						{grid && scale >= 4 && (
							<span
								className="image-pixel-grid"
								aria-hidden="true"
								style={{ backgroundSize: `${scale}px ${scale}px` }}
							/>
						)}
					</div>
				</div>
			</div>
			{comparing && (
				<ImageComparison
					src={src}
					alt={alt}
					fileBytes={bytes}
					location={location}
					onClose={() => setComparing(false)}
				/>
			)}
		</div>
	);
}

export function ImageViewer(props: {
	src: string;
	alt: string;
	onError: () => void;
	actions?: ReactNode;
	fileBytes?: number;
	location?: ImageLocation;
}) {
	return <ImageContent key={props.src} {...props} />;
}
