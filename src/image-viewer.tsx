/** Shared visual zoom; 100% uses intrinsic CSS pixels, independently of the viewport. */
import { Minus, Plus } from "lucide-react";
import { createContext, type ReactNode, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const ImageZoomContext = createContext<{
	zoom: number | null;
	setZoom: (value: number | null) => void;
} | null>(null);
/** Shares the chosen zoom/Fit mode with the reader's expanded view, including portal content. */
export function ImageZoom({ children }: { children: ReactNode }) {
	const [zoom, setZoom] = useState<number | null>(null);
	const value = useMemo(() => ({ zoom, setZoom }), [zoom]);
	return <ImageZoomContext.Provider value={value}>{children}</ImageZoomContext.Provider>;
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
	const change = (value: number) => onZoom(Math.max(25, Math.min(200, value)));
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
				max={200}
				step={5}
				value={Math.max(25, Math.min(200, percent))}
				disabled={!ready}
				aria-label={t("zoom.level")}
				aria-valuetext={fitting ? t("zoom.fitted", { percent }) : `${percent} %`}
				onChange={(e) => change(Number(e.target.value))}
			/>
			<button
				type="button"
				className="icon-button"
				aria-label={t("zoom.in")}
				disabled={!ready || percent >= 200}
				onClick={() => change(percent + 25)}
			>
				<Plus size={13} />
			</button>
			<button
				type="button"
				className="quiet-button visual-zoom-value"
				title={t("zoom.actual")}
				aria-label={t("zoom.actual")}
				disabled={!ready}
				onClick={() => change(100)}
			>
				{ready ? `${percent} %` : "—"}
			</button>
			<button type="button" className="quiet-button" aria-pressed={fitting} disabled={!ready} onClick={onFit}>
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
}: {
	src: string;
	alt: string;
	onError: () => void;
	actions?: ReactNode;
}) {
	const { t } = useTranslation("workspace");
	const [failed, setFailed] = useState(false);
	const viewport = useRef<HTMLDivElement>(null);
	const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
	const [bounds, setBounds] = useState({ width: 0, height: 0 });
	const [localZoom, setLocalZoom] = useState<number | null>(null);
	const sharedZoom = useContext(ImageZoomContext);
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
						1,
						bounds.width > 0 ? bounds.width / natural.width : 1,
						bounds.height > 0 ? bounds.height / natural.height : 1,
					)
				: 1;
	const percent = Math.max(1, Math.round(scale * 100));
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
		<div className="image-viewer" data-testid="image-viewer">
			<ZoomControls
				actions={actions}
				percent={percent}
				fitting={fitting}
				ready={!!natural}
				onZoom={(value) => setZoom(value)}
				onFit={() => {
					setZoom(null);
					resetScroll();
				}}
			/>
			<div
				ref={viewport}
				className="file-image-stage image-viewport"
				role="region"
				aria-label={alt}
				tabIndex={0}
			>
				<div className="image-canvas">
					<img
						src={src}
						alt={alt}
						referrerPolicy="no-referrer"
						draggable={false}
						style={natural ? { width: natural.width * scale, height: natural.height * scale } : undefined}
						onLoad={(event) => {
							const { naturalWidth, naturalHeight } = event.currentTarget;
							if (naturalWidth && naturalHeight) setNatural({ width: naturalWidth, height: naturalHeight });
						}}
						onError={() => {
							setFailed(true);
							onError();
						}}
					/>
				</div>
			</div>
		</div>
	);
}

export function ImageViewer(props: { src: string; alt: string; onError: () => void; actions?: ReactNode }) {
	return <ImageContent key={props.src} {...props} />;
}
