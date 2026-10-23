/** Folder-scoped thumbnails are fetched only as their cards approach the viewport. */
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderSearch, ImageOff, RefreshCw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { FileSortOptions, sortFiles } from "./file-sort";
import {
	defaultPreferences,
	type FilePreferences,
	fileWorkspace,
	type LibraryImage,
} from "./file-workspace-api";
import { useFileLabels } from "./file-workspace-labels";
import { useFinderContextMenu } from "./finder-context-menu";
import { ImageLibraryPreview } from "./image-library-preview";
import { SearchInput } from "./search-input";

export function matchesImage(path: string, query: string) {
	const normalize = (value: string) =>
		value
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLocaleLowerCase();
	const haystack = normalize(path);
	return normalize(query)
		.split(/[\s+]+/)
		.filter(Boolean)
		.every((word) => haystack.includes(word));
}

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
	onOpen: (path: string, trigger: HTMLElement) => void;
	onReveal: (path: string) => void;
	active: boolean;
}) {
	const l = useFileLabels();
	const card = useRef<HTMLDivElement>(null);
	const finder = useFinderContextMenu(root, image.path);
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
		<div
			className="library-card"
			ref={card}
			onContextMenu={finder.onContextMenu}
			onKeyDown={finder.onKeyDown}
		>
			{finder.menu}
			<button
				type="button"
				className="library-image"
				data-hint={image.path}
				aria-label={image.path}
				onClick={(event) => onOpen(image.path, event.currentTarget)}
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
				data-hint={l.revealFileHint}
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
	onFolder,
}: {
	root: string;
	folder: string;
	onOpen: (path: string) => void;
	onReveal: (path: string) => void;
	active: boolean;
	onFolder: (path: string) => void;
}) {
	const l = useFileLabels();
	const hintId = useId();
	const client = useQueryClient();
	const pref = useQuery({
		queryKey: ["file-preferences", root],
		queryFn: () => fileWorkspace.preferences(root),
		retry: false,
	});
	const preferences = pref.data ?? defaultPreferences;
	const mutationKey = ["file-preferences", root];
	const busy = useIsMutating({ mutationKey }) > 0;
	const sorting = useMutation({
		mutationKey,
		mutationFn: (request: { root: string; preferences: FilePreferences }) =>
			fileWorkspace.setPreferences(request.root, request.preferences),
		onSuccess: (value, request) => client.setQueryData(["file-preferences", request.root], value),
	});
	const [filter, setFilter] = useState("");
	const [format, setFormat] = useState("");
	const [count, setCount] = useState(48);
	const [preview, setPreview] = useState<{ path: string; trigger: HTMLElement } | null>(null);
	const query = useQuery({
		queryKey: ["image-library", root, folder],
		queryFn: () => fileWorkspace.images(root, folder),
		enabled: active,
		retry: false,
		staleTime: 30_000,
		refetchOnWindowFocus: false,
	});
	const images = sortFiles(
		(query.data?.images ?? []).filter(
			(image) => (!format || image.format === format) && matchesImage(image.path, filter),
		),
		preferences.sort,
	);
	const index = images.findIndex((image) => image.path === preview?.path);
	useEffect(() => {
		if (preview && (!active || index < 0)) setPreview(null);
	}, [active, index, preview]);
	return (
		<section className="image-library" aria-label={l.library}>
			<header className="library-toolbar">
				<div className="library-scope">
					<strong>{l.images}</strong>
					<small title={`${root}/${folder}`}>
						{l.libraryScope} · {folder || root.split("/").pop()}
					</small>
					<nav className="library-breadcrumbs" aria-label={`${l.library} · ${l.folder}`}>
						<button type="button" className="quiet-button" onClick={() => onFolder("")}>
							{root.split("/").pop()}
						</button>
						{folder
							.split("/")
							.filter(Boolean)
							.map((part, index, parts) => (
								<span key={parts.slice(0, index + 1).join("/")}>
									{" "}
									/{" "}
									<button
										type="button"
										className="quiet-button"
										onClick={() => onFolder(parts.slice(0, index + 1).join("/"))}
									>
										{part}
									</button>
								</span>
							))}
					</nav>
				</div>
				<SearchInput
					type="search"
					maxLength={1000}
					aria-label={l.imageFilter}
					data-hint={l.imageSearchHint}
					aria-describedby={hintId}
					placeholder={l.imageFilter}
					value={filter}
					onClear={() => {
						setFilter("");
						setCount(48);
					}}
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
				<select
					aria-label={l.sort}
					value={preferences.sort || "name"}
					disabled={pref.isPending || !!pref.error || busy}
					onChange={(e) => {
						if (!client.isMutating({ mutationKey }))
							sorting.mutate({ root, preferences: { ...preferences, sort: e.target.value } });
					}}
				>
					<FileSortOptions />
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
			<small id={hintId} className="library-search-hint">
				{l.imageSearchHint}
			</small>
			{(pref.error || sorting.error) && (
				<p className="inline-error" role="alert">
					{String(pref.error || sorting.error)}
				</p>
			)}
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
						onOpen={(path, trigger) => setPreview({ path, trigger })}
						onReveal={onReveal}
					/>
				))}
			</div>
			{preview && index >= 0 && (
				<ImageLibraryPreview
					root={root}
					image={images[index]}
					index={index}
					total={images.length}
					trigger={preview.trigger}
					onClose={() => setPreview(null)}
					onStep={(direction) => {
						const next = images[index + direction];
						if (next) setPreview({ ...preview, path: next.path });
					}}
					onOpen={() => {
						setPreview(null);
						onOpen(preview.path);
					}}
					onReveal={() => {
						setPreview(null);
						onReveal(preview.path);
					}}
				/>
			)}
			{images.length > count && (
				<div>
					<button type="button" className="quiet-button library-more" onClick={() => setCount(count + 48)}>
						{l.moreImages} · {Math.min(48, images.length - count)}
					</button>
					<button type="button" className="quiet-button" onClick={() => setCount(Number.POSITIVE_INFINITY)}>
						{l.loadAllImages}
					</button>
				</div>
			)}
		</section>
	);
}
