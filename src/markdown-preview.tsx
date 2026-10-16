/** Read-only Markdown with sanitized HTML and local or HTTP(S) images. */

import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { api } from "./api";

function pixelDimension(value?: string | number): number | undefined {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : undefined;
}

function MarkdownImage({
	project,
	path,
	src,
	alt,
	width,
	height,
}: {
	project: string;
	path: string;
	src?: string;
	alt?: string;
	width?: string | number;
	height?: string | number;
}) {
	const { t } = useTranslation("workspace");
	const [failed, setFailed] = useState<string | null>(null);
	const [intrinsic, setIntrinsic] = useState<{ source: string; ratio: number } | null>(null);
	let remote: string | undefined;
	try {
		const url = new URL(src?.startsWith("//") ? `https:${src}` : (src ?? ""));
		if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) remote = url.href;
	} catch {
		/* Relative images use the native reader. */
	}
	const local = Boolean(src && !/^(?:[a-z][a-z\d+.-]*:|[\\/]|#)/i.test(src));
	const image = useQuery({
		queryKey: ["markdown-image", project, path, src],
		queryFn: () => api.markdownImage(project, path, src ?? ""),
		enabled: local,
		retry: false,
		gcTime: 0,
	});
	const resolved = remote ?? image.data;
	const requestedWidth = pixelDimension(width);
	const requestedHeight = pixelDimension(height);
	const naturalRatio = intrinsic && intrinsic.source === resolved ? intrinsic.ratio : undefined;
	const displayWidth =
		requestedWidth ?? (requestedHeight && naturalRatio ? requestedHeight * naturalRatio : undefined);
	const ratio = requestedWidth && requestedHeight ? requestedWidth / requestedHeight : undefined;
	return resolved && failed !== resolved ? (
		<img
			src={resolved}
			alt={alt ?? ""}
			width={width}
			height={height}
			style={{ width: displayWidth, height: displayWidth ? "auto" : requestedHeight, aspectRatio: ratio }}
			referrerPolicy="no-referrer"
			className="markdown-local-image"
			onError={() => setFailed(resolved)}
			onLoad={(event) => {
				const { naturalWidth, naturalHeight } = event.currentTarget;
				if (naturalWidth && naturalHeight)
					setIntrinsic({ source: resolved, ratio: naturalWidth / naturalHeight });
			}}
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
		({
			alt,
			src,
			width,
			height,
		}: {
			alt?: string;
			src?: string | Blob;
			width?: string | number;
			height?: string | number;
		}) => (
			<MarkdownImage
				project={project}
				path={path}
				src={typeof src === "string" ? src : undefined}
				alt={alt}
				width={width}
				height={height}
			/>
		),
		[project, path],
	);
	return (
		<div className="markdown-scroll" data-testid="markdown-preview">
			<article className="markdown-preview">
				<Markdown
					remarkPlugins={[remarkGfm]}
					rehypePlugins={[rehypeRaw, rehypeSanitize]}
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
