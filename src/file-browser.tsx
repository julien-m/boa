import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Filter, Images, Pin, X } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { FileSearchPanel } from "./file-search-panel";
import { FileTree } from "./file-tree";
import { useCloseImageLibrary, useImageLibrary, useLibraryFolder } from "./file-workspace";
import { defaultPreferences, type FilePreferences, fileWorkspace } from "./file-workspace-api";
import { useFileLabels } from "./file-workspace-labels";
import type { DirectoryEntry, Selection } from "./models";
export interface TreeOptions {
	preferences: FilePreferences;
	manage: boolean;
	busy: boolean;
	showAll: boolean;
	reveal: string;
	select?: (path: string) => void;
	update: (prefs: FilePreferences) => void;
}
const TreeOptionsContext = createContext<TreeOptions>({
	preferences: defaultPreferences,
	manage: false,
	busy: false,
	showAll: false,
	reveal: "",
	update: () => {},
});
export const useTreeOptions = () => useContext(TreeOptionsContext);
export function toggleIncluded(prefs: FilePreferences, path: string, checked: boolean): FilePreferences {
	// Unchecking a child of an included folder is intentionally explicit: split the selection in the chooser first.
	return {
		...prefs,
		filtered: true,
		included: checked
			? [...prefs.included.filter((p) => !p.startsWith(`${path}/`) && p !== path), path]
			: prefs.included.filter((p) => p !== path && !p.startsWith(`${path}/`)),
	};
}
export function FileBrowser({
	root,
	repos = [],
	selected,
	onOpen,
	onKeepOpen,
	folder = "",
	folderRequestId,
}: {
	root: string;
	repos?: import("./models").RepoStatus[];
	selected?: string;
	onOpen: (selection: Selection) => void;
	onKeepOpen?: (selection: Selection) => void;
	folder?: string;
	folderRequestId?: string;
}) {
	const l = useFileLabels();
	const openLibrary = useImageLibrary();
	const chooseFolder = useLibraryFolder();
	const closeLibrary = useCloseImageLibrary();
	const [treeSelection, setTreeSelection] = useState(selected);
	const select = (path: string) =>
		window.dispatchEvent(new CustomEvent("boa:tree-selection", { detail: { root, path } }));
	useEffect(() => {
		setTreeSelection(selected);
	}, [selected, root]);
	useEffect(() => {
		const listener = (event: Event) => {
			const detail = (event as CustomEvent<{ root: string; path: string }>).detail;
			setTreeSelection(detail.root === root ? detail.path : undefined);
		};
		window.addEventListener("boa:tree-selection", listener);
		return () => window.removeEventListener("boa:tree-selection", listener);
	}, [root]);
	const openFile = (selection: Selection) => {
		select(selection.path);
		closeLibrary?.();
		onOpen(selection);
	};
	const client = useQueryClient();
	const pref = useQuery({
		queryKey: ["file-preferences", root],
		queryFn: () => fileWorkspace.preferences(root),
		retry: false,
	});
	const preferences = pref.data ?? defaultPreferences;
	const [manage, setManage] = useState(false);
	const [showAll, setShowAll] = useState(false);
	const [menu, setMenu] = useState(false);
	const [path, setPath] = useState(folder);
	const [search, setSearch] = useState<string | null>(null);
	const browser = useRef<HTMLDivElement>(null);
	const closeSearch = () => {
		setSearch(null);
		browser.current?.focus({ preventScroll: true });
	};
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [revealTarget, setRevealTarget] = useState("");
	useEffect(() => {
		const browse = (event: Event) => {
			const detail = (event as CustomEvent<{ root: string; folder: string }>).detail;
			if (detail.root === root) {
				setPath(detail.folder);
				setSearch(null);
			}
		};
		window.addEventListener("boa:library-folder", browse);
		return () => window.removeEventListener("boa:library-folder", browse);
	}, [root]);
	useEffect(() => {
		const reveal = (e: Event) => {
			const detail = (e as CustomEvent<{ root: string; path: string }>).detail;
			if (detail.root !== root) return;
			setPath(detail.path.includes("/") ? detail.path.slice(0, detail.path.lastIndexOf("/")) : "");
			setSearch(null);
			select(detail.path);
			setRevealTarget(detail.path);
		};
		window.addEventListener("boa:reveal-file", reveal);
		return () => window.removeEventListener("boa:reveal-file", reveal);
	}, [root]);
	useEffect(() => {
		if (!revealTarget || !browser.current) return;
		const element = browser.current;
		const reveal = () => {
			const row = [...element.querySelectorAll<HTMLElement>("[data-testid]")].find(
				(node) => node.dataset.testid === `file-${revealTarget}`,
			);
			if (row) {
				row.scrollIntoView?.({ block: "nearest" });
				row.focus({ preventScroll: true });
				setRevealTarget("");
			}
		};
		const observer = new MutationObserver(reveal);
		observer.observe(element, { childList: true, subtree: true });
		reveal();
		const timeout = setTimeout(() => setRevealTarget(""), 3000);
		return () => {
			observer.disconnect();
			clearTimeout(timeout);
		};
	}, [revealTarget]);
	useEffect(() => {
		setPath(folder);
		if (folderRequestId) chooseFolder?.(root, folder);
	}, [folder, folderRequestId, root, chooseFolder]);
	useEffect(() => {
		const listener = (e: Event) => {
			if ((e as CustomEvent).detail?.root === root) setSearch("");
		};
		window.addEventListener("boa:tree-search", listener);
		return () => window.removeEventListener("boa:tree-search", listener);
	}, [root]);
	const update = (value: FilePreferences) => {
		if (busy) return;
		setBusy(true);
		setError("");
		const previous = preferences;
		client.setQueryData(["file-preferences", root], value);
		void fileWorkspace
			.setPreferences(root, value)
			.then((p) => {
				client.setQueryData(["file-preferences", root], p);
				void client.invalidateQueries({ queryKey: ["image-library", root] });
			})
			.catch((e) => {
				client.setQueryData(["file-preferences", root], previous);
				setError(String(e));
			})
			.finally(() => setBusy(false));
	};
	const choosePin = async (value: string) => {
		try {
			const parent = value.includes("/") ? value.slice(0, value.lastIndexOf("/")) : "";
			const entry = (await api.directory(root, parent)).find((e) => e.path === value);
			if (!entry) throw new Error(value);
			if (entry.directory) {
				select(value);
				setPath(value);
				chooseFolder?.(root, value);
			} else openFile({ project: root, path: value });
		} catch (e) {
			setError(String(e));
		}
	};
	const reorder = (from: number, to: number) => {
		if (to < 0 || to >= preferences.pins.length) return;
		const pins = [...preferences.pins];
		const [item] = pins.splice(from, 1);
		pins.splice(to, 0, item);
		update({ ...preferences, pins });
	};
	return (
		<div
			ref={browser}
			data-file-browser={root}
			className="file-browser"
			tabIndex={0}
			onPointerDown={(e) => {
				if (!(e.target as HTMLElement).closest("button,input,select,textarea,[contenteditable]"))
					browser.current?.focus({ preventScroll: true });
			}}
			onKeyDown={(e) => {
				const editable = (e.target as HTMLElement).closest("input,textarea,select,[contenteditable]");
				if (
					search === null &&
					!editable &&
					!e.nativeEvent.isComposing &&
					!e.metaKey &&
					!e.ctrlKey &&
					!e.altKey &&
					e.key.length === 1 &&
					e.key.trim()
				) {
					e.preventDefault();
					setSearch(e.key);
				}
				if (e.key === "Escape") {
					setSearch(null);
					setMenu(false);
					setManage(false);
				}
			}}
		>
			<div className="file-browser-toolbar">
				<button
					type="button"
					className="quiet-button truncate file-browser-root"
					data-hint={root}
					onClick={() => {
						setPath("");
						chooseFolder?.(root, "");
					}}
				>
					{root.split("/").pop() || root}
				</button>
				{openLibrary && (
					<button
						type="button"
						className="icon-button"
						aria-label={l.folderImages}
						data-hint={l.folderImages}
						onClick={() => openLibrary(root, path)}
					>
						<Images size={14} />
					</button>
				)}
				<button
					type="button"
					className="icon-button"
					aria-label={l.filter}
					data-hint={l.filter}
					onClick={() => setMenu(!menu)}
				>
					<Filter size={13} />
				</button>
			</div>
			{menu && (
				<div className="file-browser-options">
					<label>
						<input
							type="checkbox"
							checked={preferences.filtered}
							disabled={busy}
							onChange={(e) => update({ ...preferences, filtered: e.target.checked })}
						/>
						{l.selected}
					</label>
					<button
						type="button"
						className="quiet-button"
						onClick={() => {
							setManage(!manage);
							if (!manage && !preferences.filtered) update({ ...preferences, filtered: true });
							setMenu(false);
						}}
					>
						{l.manage}
					</button>
					<button type="button" className="quiet-button" onClick={() => setShowAll(!showAll)}>
						{showAll ? l.restoreSelection : l.all}
					</button>
					<select
						aria-label={l.filter}
						value={preferences.sort || "name"}
						disabled={busy}
						onChange={(e) => update({ ...preferences, sort: e.target.value })}
					>
						<option value="name">{l.nameSort}</option>
						<option value="modified">{l.modifiedSort}</option>
					</select>
				</div>
			)}
			{pref.error && <p className="inline-error">{String(pref.error)}</p>}
			{error && (
				<p className="inline-error" role="alert">
					{error}
				</p>
			)}
			{manage && (
				<div className="file-browser-options">
					<p>{l.inclusionHint}</p>
					<button type="button" className="quiet-button" onClick={() => setManage(false)}>
						{l.close}
					</button>
				</div>
			)}
			{path && (
				<button
					type="button"
					className="quiet-button"
					data-hint={path}
					onClick={() => {
						setPath("");
						chooseFolder?.(root, "");
					}}
				>
					← {l.back} · {path}
				</button>
			)}
			{search === null && preferences.pins.length > 0 && (
				<div className="tree-pins">
					<small>{l.pins}</small>
					{preferences.pins.map((pin, index) => (
						<div
							key={pin}
							className="tree-pin"
							draggable={!busy}
							onDragStart={(e) =>
								e.dataTransfer.setData("application/x-boa-pin", JSON.stringify({ root, index }))
							}
							onDragOver={(e) => e.preventDefault()}
							onDrop={(e) => {
								e.preventDefault();
								const value = e.dataTransfer.getData("application/x-boa-pin");
								try {
									const source = JSON.parse(value);
									if (
										source.root === root &&
										Number.isInteger(source.index) &&
										source.index >= 0 &&
										source.index < preferences.pins.length
									)
										reorder(source.index, index);
								} catch {}
							}}
						>
							<button
								type="button"
								className="tree-pin-open"
								data-hint={pin}
								onClick={() => void choosePin(pin)}
							>
								<Pin size={12} />
								<span className="truncate">{pin}</span>
							</button>
							<button
								type="button"
								className="icon-button"
								aria-label={l.up}
								disabled={busy || index === 0}
								onClick={() => reorder(index, index - 1)}
							>
								<ArrowUp size={11} />
							</button>
							<button
								type="button"
								className="icon-button"
								aria-label={l.down}
								disabled={busy || index === preferences.pins.length - 1}
								onClick={() => reorder(index, index + 1)}
							>
								<ArrowDown size={11} />
							</button>
							<button
								type="button"
								className="icon-button"
								aria-label={l.unpin}
								disabled={busy}
								onClick={() => update({ ...preferences, pins: preferences.pins.filter((p) => p !== pin) })}
							>
								<X size={11} />
							</button>
						</div>
					))}
				</div>
			)}
			{search !== null && (
				<FileSearchPanel
					roots={[path ? `${root}/${path}` : root]}
					mode="paths"
					initialInput={search}
					live
					onClose={closeSearch}
					onOpen={(hit) => {
						if (hit.directory) {
							select(hit.path);
							setPath(hit.path);
							chooseFolder?.(root, hit.path);
							setSearch(null);
						} else openFile({ ...hit, line: hit.line || undefined });
					}}
				/>
			)}
			<div hidden={search !== null}>
				<TreeOptionsContext.Provider
					value={{ preferences, manage, busy, showAll: showAll || manage, reveal: path, select, update }}
				>
					<FileTree
						project={root}
						path={path}
						repos={repos}
						selected={treeSelection}
						onOpen={(p) => openFile({ project: root, path: p })}
						onKeepOpen={(p) => onKeepOpen?.({ project: root, path: p })}
					/>
				</TreeOptionsContext.Provider>
			</div>
			{search === null && preferences.filtered && !preferences.included.length && !showAll && !manage && (
				<p className="muted small">{l.noneVisible}</p>
			)}
		</div>
	);
}
export function orderedEntries(entries: DirectoryEntry[], prefs: FilePreferences) {
	return [...entries].sort((a, b) =>
		prefs.sort === "modified"
			? (b.modified ?? 0) - (a.modified ?? 0) || a.name.localeCompare(b.name)
			: Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
	);
}
