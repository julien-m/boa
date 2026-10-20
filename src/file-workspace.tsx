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
import { useFileLabels } from "./file-workspace-labels";
import { ImageLibrary } from "./image-library";
import type { Selection } from "./models";
import { PanelResizer } from "./panel-resizer";

const ImageLibraryContext = createContext<{
	open: (root: string, folder: string) => void;
	folder: (root: string, folder: string) => void;
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
}: {
	tree: ReactNode;
	children: ReactNode;
	libraryRoot?: string;
	onOpen?: (selection: Selection) => void;
	navigationKey?: string;
}) {
	const { t } = useTranslation("workspace");
	const l = useFileLabels();
	const [showTree, setShowTree] = useState(true);
	const [library, setLibrary] = useState(false);
	const closeLibrary = useCallback(() => setLibrary(false), []);
	const [scope, setScope] = useState({ root: libraryRoot ?? "", folder: "" });
	const previousRoot = useRef(libraryRoot);
	const openLibrary = useCallback((root: string, folder: string) => {
		setScope({ root, folder });
		setLibrary(true);
	}, []);
	const chooseFolder = useCallback(
		(root: string, folder: string) =>
			setScope((current) =>
				current.root === root && current.folder === folder ? current : { root, folder },
			),
		[],
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
		setLibrary(false);
	}, [navigationKey]);
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
						{showTree && <span>{t("project.filesHeading")}</span>}
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
					<div className="tree-scroll" hidden={!showTree}>
						{tree}
					</div>
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
								onClick={() => setLibrary(false)}
							>
								{l.files}
							</button>
							<button
								type="button"
								className={library ? "active" : ""}
								aria-pressed={library}
								onClick={() => setLibrary(true)}
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
