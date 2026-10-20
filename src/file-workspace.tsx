/** Collapse is local: the reader and expanded folders stay mounted. */
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PanelResizer } from "./panel-resizer";

export function FileWorkspace({ tree, children }: { tree: ReactNode; children: ReactNode }) {
	const { t } = useTranslation("workspace");
	const [showTree, setShowTree] = useState(true);
	const container = useRef<HTMLDivElement>(null);
	return (
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
						title={showTree ? t("project.hideTree") : t("project.showTree")}
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
			{children}
		</div>
	);
}
