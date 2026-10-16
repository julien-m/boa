/** Read-only Markdown document; remote resources never load automatically. */

import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "./api";

function LocalImage({
	project,
	path,
	src,
	alt,
}: {
	project: string;
	path: string;
	src?: string;
	alt?: string;
}) {
	const { t } = useTranslation("workspace");
	const [failed, setFailed] = useState<string | null>(null);
	const local = Boolean(src && !/^(?:[a-z][a-z\d+.-]*:|[\\/]|#)/i.test(src));
	const image = useQuery({
		queryKey: ["markdown-image", project, path, src],
		queryFn: () => api.markdownImage(project, path, src ?? ""),
		enabled: local,
		retry: false,
		gcTime: 0,
	});
	return image.data && failed !== image.data ? (
		<img
			src={image.data}
			alt={alt ?? ""}
			className="markdown-local-image"
			onError={() => setFailed(image.data ?? null)}
		/>
	) : (
		<span className="markdown-image" title={image.error ? String(image.error) : src}>
			{t("markdown.image", { alt: alt || t("markdown.noDescription") })}
		</span>
	);
}

export function MarkdownPreview({
	content,
	project,
	path,
	onCopyLink,
}: {
	content: string;
	project: string;
	path: string;
	onCopyLink: (href: string) => void;
}) {
	const { t } = useTranslation("workspace");
	const renderImage = useCallback(
		({ alt, src }: { alt?: string; src?: string | Blob }) => (
			<LocalImage project={project} path={path} src={typeof src === "string" ? src : undefined} alt={alt} />
		),
		[project, path],
	);
	return (
		<div className="markdown-scroll" data-testid="markdown-preview">
			<article className="markdown-preview">
				<Markdown
					remarkPlugins={[remarkGfm]}
					skipHtml
					components={{
						a: ({ href, children }) => (
							<a
								href={href}
								title={t("markdown.copyLink")}
								onClick={(event) => {
									event.preventDefault();
									if (href?.startsWith("#")) {
										return;
									}
									if (href) onCopyLink(href);
								}}
							>
								{children}
							</a>
						),
						img: renderImage,
					}}
				>
					{content}
				</Markdown>
			</article>
		</div>
	);
}
