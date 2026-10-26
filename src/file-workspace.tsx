/** Collapse is local: the reader and expanded folders stay mounted. */
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { HistoryRestoration, RecordVisit } from "./app-history";
import { useContextLabels } from "./context-labels";
import { useFileLabels } from "./file-workspace-labels";
import { ImageLibrary } from "./image-library";
import type { Selection } from "./models";
import { PanelResizer } from "./panel-resizer";

const ImageLibraryContext = createContext<{
	open: (root: string, folder: string) => void;
	folder: (root: string, folder: string, record?: boolean) => void;
	close: () => void;
} | null>(null);
export const useImageLibrary = () => useContext(ImageLibraryContext)?.open;
export const useCloseImageLibrary = () => useContext(ImageLibraryContext)?.close;
export const useLibraryFolder = () => useContext(ImageLibraryContext)?.folder;

export function FileWorkspace({
	tree,
	children,
	libraryRoot,
	onOpen,
	navigationKey,
	onVisit,
	restoration,
	context,
	contextVisible = false,
	onContextVisibleChange,
}: {
	onVisit?: RecordVisit;
	restoration?: HistoryRestoration | null;
	tree: ReactNode;
	children: ReactNode;
	libraryRoot?: string;
	onOpen?: (selection: Selection) => void;
	navigationKey?: string;
	context?: ReactNode;
	contextVisible?: boolean;
	onContextVisibleChange?: (visible: boolean) => void;
}) {
	const { t } = useTranslation("workspace");
	const l = useFileLabels();
	const contextLabels = useContextLabels();
	const [showTree, setShowTree] = useState(true);
	const [library, setLibrary] = useState(false);
	const closeLibrary = useCallback(() => setLibrary(false), []);
	const restoring = useRef(Boolean(restoration));
	restoring.current = Boolean(restoration);
	const libraryRef = useRef(library);
	libraryRef.current = library;
	const [scope, setScope] = useState({ root: libraryRoot ?? "", folder: "" });
	const previousRoot = useRef(libraryRoot);
	const openLibrary = useCallback(
		(root: string, folder: string) => {
			setScope({ root, folder });
			setLibrary(true);
			onVisit?.({ library: { root, folder } });
		},
		[onVisit],
	);
	const chooseFolder = useCallback(
		(root: string, folder: string, record = true) => {
			// Restoring each tree must not overwrite the shared scope restored by this workspace.
			// A ref keeps this callback stable when a later user action ends restoration.
			if (!record && restoring.current) return;
			setScope((current) =>
				current.root === root && current.folder === folder ? current : { root, folder },
			);
			// Requests used to restore a folder are already represented in history.
			if (record)
				onVisit?.({ folder: { root, folder }, ...(libraryRef.current ? { library: { root, folder } } : {}) });
		},
		[onVisit],
	);
	const libraryActions = useMemo(
		() => ({ open: openLibrary, folder: chooseFolder, close: closeLibrary }),
		[openLibrary, chooseFolder, closeLibrary],
	);
	useEffect(() => {
		if (previousRoot.current === libraryRoot) return;
		previousRoot.current = libraryRoot;
		setScope({ root: libraryRoot ?? "", folder: "" });
		setLibrary(false);
	}, [libraryRoot]);
	useEffect(() => {
		if (!restoration) setLibrary(false);
	}, [navigationKey]);
	useEffect(() => {
		if (!restoration) return;
		setLibrary(Boolean(restoration.workspace.library));
		const scope = restoration.workspace.library ?? restoration.workspace.folder;
		setScope(scope ?? { root: libraryRoot ?? "", folder: "" });
	}, [restoration]);
	useEffect(() => {
		const reveal = () => {
			setShowTree(true);
			onContextVisibleChange?.(false);
			setLibrary(false);
		};
		window.addEventListener("boa:reveal-file", reveal);
		return () => window.removeEventListener("boa:reveal-file", reveal);
	}, [onContextVisibleChange]);
	const showImage = (path: string, reveal = false) => {
		onOpen?.({ project: scope.root, path });
		setLibrary(false);
		if (reveal) {
			setShowTree(true);
			window.dispatchEvent(new CustomEvent("boa:reveal-file", { detail: { root: scope.root, path } }));
		}
	};
	const container = useRef<HTMLDivElement>(null);
	return (
		<ImageLibraryContext.Provider value={onOpen ? libraryActions : null}>
			<div ref={container} className={`file-workspace collapsible-files ${showTree ? "" : "no-tree"}`}>
				<aside className={`file-sidebar ${showTree ? "" : "collapsed"}`}>
					<div className="pane-heading">
						{showTree &&
							(context ? (
								<div className="context-sidebar-tabs" role="group" aria-label={contextLabels.views}>
									<button
										type="button"
										className={contextVisible ? "" : "active"}
										aria-pressed={!contextVisible}
										onClick={() => onContextVisibleChange?.(false)}
									>
										{contextLabels.files}
									</button>
									<button
										type="button"
										className={contextVisible ? "active" : ""}
										aria-pressed={contextVisible}
										onClick={() => onContextVisibleChange?.(true)}
										data-testid="toggle-context-views"
									>
										{contextLabels.context}
									</button>
								</div>
							) : (
								<span>{t("project.filesHeading")}</span>
							))}
						<button
							type="button"
							className="icon-button"
							data-testid="toggle-file-tree"
							aria-label={showTree ? t("project.hideTree") : t("project.showTree")}
							aria-expanded={showTree}
							data-hint={showTree ? t("project.hideTree") : t("project.showTree")}
							onClick={() => setShowTree((value) => !value)}
						>
							{showTree ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
						</button>
					</div>
					<div className="tree-scroll" hidden={!showTree || contextVisible}>
						{tree}
					</div>
					{context && (
						<div className="context-sidebar-slot" hidden={!showTree || !contextVisible}>
							{context}
						</div>
					)}
				</aside>
				<div className="file-tree-resizer-slot" inert={!showTree} aria-hidden={!showTree}>
					<PanelResizer container={container} vertical fileTree />
				</div>
				<div className="file-workspace-content">
					{libraryRoot && (
						<nav className="library-tabs" aria-label={l.files}>
							<button
								type="button"
								className={library ? "" : "active"}
								aria-pressed={!library}
								onClick={() => {
									closeLibrary();
									onVisit?.({ library: null });
								}}
							>
								{l.files}
							</button>
							<button
								type="button"
								className={library ? "active" : ""}
								aria-pressed={library}
								onClick={() => openLibrary(scope.root, scope.folder)}
							>
								{l.library}
							</button>
						</nav>
					)}
					<div className="workspace-reader" hidden={library}>
						{children}
					</div>
					{scope.root && (
						<div className="workspace-library" hidden={!library}>
							<ImageLibrary
								active={library}
								key={JSON.stringify(scope)}
								root={scope.root}
								folder={scope.folder}
								onOpen={(path) => showImage(path)}
								onReveal={(path) => showImage(path, true)}
								onFolder={(folder) => {
									chooseFolder(scope.root, folder);
									window.dispatchEvent(
										new CustomEvent("boa:library-folder", { detail: { root: scope.root, folder } }),
									);
								}}
							/>
						</div>
					)}
				</div>
			</div>
		</ImageLibraryContext.Provider>
	);
}
