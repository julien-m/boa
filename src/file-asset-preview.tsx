/** Bounded native image data; other formats open only after an explicit user action. */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import { ImageViewer, ImageZoom } from "./image-viewer";
import { MarkdownExpandButton, MarkdownExpansion } from "./markdown-expand";
import type { Preview, Selection } from "./models";

export function FileAssetPreview({ preview, selection }: { preview: Preview; selection: Selection }) {
	const { t } = useTranslation("workspace");
	const [failed, setFailed] = useState<string | null>(null);
	const [opening, setOpening] = useState(false);
	const [error, setError] = useState("");
	const image = preview.kind === "image" && preview.dataUrl && failed !== preview.dataUrl;
	const label = selection.path.split("/").pop() ?? "";
	return (
		<div className="file-asset-preview" data-testid="file-asset-preview">
			{image ? (
				<ImageZoom key={preview.dataUrl!}>
					<MarkdownExpansion
						key={JSON.stringify([selection.project, selection.path])}
						revision={preview.dataUrl!}
					>
						<ImageViewer
							src={preview.dataUrl!}
							alt={label}
							onError={() => setFailed(preview.dataUrl ?? null)}
							actions={
								<MarkdownExpandButton
									toolbar
									label={label}
									content={<ImageViewer src={preview.dataUrl!} alt={label} onError={() => {}} />}
								/>
							}
						/>
					</MarkdownExpansion>
				</ImageZoom>
			) : (
				<div className="file-asset-message" role="status">
					<h2>{t("asset.unavailable")}</h2>
					<p>{preview.kind === "image" ? t("asset.imageFailed") : t("asset.externalHint")}</p>
					{preview.reason && <p>{preview.reason}</p>}
				</div>
			)}
			<div className="file-asset-actions">
				<button
					type="button"
					data-testid="open-external-file"
					disabled={opening}
					onClick={() => {
						setOpening(true);
						setError("");
						void api
							.openFile(selection.project, selection.path)
							.catch((reason: unknown) => setError(String(reason)))
							.finally(() => setOpening(false));
					}}
				>
					{t("asset.openExternal")}
				</button>
				{error && <p role="alert">{error}</p>}
			</div>
		</div>
	);
}
