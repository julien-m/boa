/** Folder-scoped thumbnails are fetched only as their cards approach the viewport. */
import { useQuery } from "@tanstack/react-query";
import { FolderSearch, ImageOff, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fileWorkspace, type LibraryImage } from "./file-workspace-api";
import { useFileLabels } from "./file-workspace-labels";

let active = 0;
const waiting: (() => void)[] = [];
async function thumbnail(root: string, path: string, signal: AbortSignal) {
	if (active >= 3) await new Promise<void>((resolve) => waiting.push(resolve));
	else active++;
	try {
		signal.throwIfAborted();
		return await fileWorkspace.thumbnail(root, path);
	} finally {
		const next = waiting.shift();
		if (next) next();
		else active--;
	}
}

function ImageCard({
	root,
	image,
	onOpen,
	onReveal,
	active,
}: {
	root: string;
	image: LibraryImage;
	onOpen: (path: string) => void;
	onReveal: (path: string) => void;
	active: boolean;
}) {
	const l = useFileLabels();
	const card = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(false);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry.isIntersecting) {
					setVisible(true);
					observer.disconnect();
				}
			},
			{ rootMargin: "160px" },
		);
		if (card.current) observer.observe(card.current);
		return () => observer.disconnect();
	}, []);
	const query = useQuery({
		queryKey: ["image-thumbnail", root, image.path, image.modified, image.size],
		queryFn: ({ signal }) => thumbnail(root, image.path, signal),
		enabled: active && visible,
		retry: false,
		staleTime: 60_000,
		gcTime: 30_000,
		refetchOnWindowFocus: false,
	});
	return (
		<div className="library-card" ref={card}>
			<button
				type="button"
				className="library-image"
				title={image.path}
				aria-label={image.path}
				onClick={() => onOpen(image.path)}
			>
				<span className="library-thumbnail">
					{query.data && !failed ? (
						<img src={query.data} alt="" draggable={false} onError={() => setFailed(true)} />
					) : (
						<ImageOff size={24} />
					)}
					{(query.error || failed) && <small>{l.thumbnailUnavailable}</small>}
				</span>
				<strong className="truncate">{image.name}</strong>
				<small className="truncate">{image.path}</small>
			</button>
			<button
				type="button"
				className="icon-button library-reveal"
				aria-label={`${l.revealFile} : ${image.path}`}
				title={l.revealFile}
				onClick={() => onReveal(image.path)}
			>
				<FolderSearch size={14} />
			</button>
		</div>
	);
}

export function ImageLibrary({
	root,
	folder,
	onOpen,
	onReveal,
	active,
}: {
	root: string;
	folder: string;
	onOpen: (path: string) => void;
	onReveal: (path: string) => void;
	active: boolean;
}) {
	const l = useFileLabels();
	const [filter, setFilter] = useState("");
	const [format, setFormat] = useState("");
	const [count, setCount] = useState(48);
	const query = useQuery({
		queryKey: ["image-library", root, folder],
		queryFn: () => fileWorkspace.images(root, folder),
		enabled: active,
		retry: false,
		staleTime: 30_000,
		refetchOnWindowFocus: false,
	});
	const images = (query.data?.images ?? []).filter(
		(image) =>
			(!format || image.format === format) &&
			image.path.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
	);
	return (
		<section className="image-library" aria-label={l.library}>
			<header className="library-toolbar">
				<div className="library-scope">
					<strong>{l.images}</strong>
					<small title={`${root}/${folder}`}>
						{l.libraryScope} · {folder || root.split("/").pop()}
					</small>
				</div>
				<input
					type="search"
					aria-label={l.imageFilter}
					placeholder={l.imageFilter}
					value={filter}
					onChange={(e) => {
						setFilter(e.target.value);
						setCount(48);
					}}
				/>
				<select
					aria-label={l.imageType}
					value={format}
					onChange={(e) => {
						setFormat(e.target.value);
						setCount(48);
					}}
				>
					<option value="">{l.allImageTypes}</option>
					{["png", "jpeg", "webp", "gif", "svg"].map((value) => (
						<option key={value} value={value}>
							{value.toUpperCase()}
						</option>
					))}
				</select>
				<button
					type="button"
					className="icon-button"
					aria-label={l.refreshImages}
					disabled={query.isFetching}
					onClick={() => void query.refetch()}
				>
					<RefreshCw size={14} className={query.isFetching ? "spin" : ""} />
				</button>
				<span className="muted small" role="status">
					{query.isPending ? l.loading : `${images.length} ${l.images.toLowerCase()}`}
				</span>
			</header>
			{query.error && (
				<p className="inline-error" role="alert">
					{String(query.error)}
				</p>
			)}
			{query.data?.limited && (
				<p className="inline-status" role="status">
					{l.imageLimited}
				</p>
			)}
			{!query.isPending && !query.error && !images.length && <p className="inline-status">{l.imageEmpty}</p>}
			<div className="library-grid">
				{images.slice(0, count).map((image) => (
					<ImageCard
						active={active}
						key={`${image.path}:${image.modified}:${image.size}`}
						root={root}
						image={image}
						onOpen={onOpen}
						onReveal={onReveal}
					/>
				))}
			</div>
			{images.length > count && (
				<button type="button" className="quiet-button library-more" onClick={() => setCount(count + 48)}>
					{l.moreImages} · {Math.min(48, images.length - count)}
				</button>
			)}
		</section>
	);
}
