/** Read-only Markdown with sanitized HTML and local or HTTP(S) images. */

import { useQuery } from "@tanstack/react-query";
import {
	Children,
	createElement,
	isValidElement,
	type ReactNode,
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { api } from "./api";
import { ImageViewer } from "./image-viewer";
import { MarkdownExpandable, MarkdownExpandButton, MarkdownExpansion } from "./markdown-expand";

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
	const display =
		resolved && failed !== resolved ? (
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
	return (
		<MarkdownExpandable
			label={alt || t("markdown.diagram")}
			inline
			expandedContent={
				resolved && failed !== resolved ? (
					<ImageViewer
						src={resolved}
						alt={alt || t("markdown.diagram")}
						onError={() => setFailed(resolved)}
					/>
				) : undefined
			}
		>
			{display}
		</MarkdownExpandable>
	);
}

function MarkdownTable({
	node,
	children,
	...props
}: {
	node?: { position?: { start: { line: number }; end: { line: number } } };
	children?: ReactNode;
}) {
	const { t } = useTranslation("workspace");
	return (
		<MarkdownExpandable label={t("markdown.tableLabel")}>
			<div className="markdown-table-scroll" role="region" aria-label={t("markdown.table")} tabIndex={0}>
				<table
					{...props}
					data-source-line={node?.position?.start.line}
					data-source-end-line={node?.position?.end.line}
				>
					{children}
				</table>
			</div>
		</MarkdownExpandable>
	);
}

function MarkdownCodeBlock({
	node,
	children,
	...props
}: {
	node?: { position?: { start: { line: number }; end: { line: number } } };
	children?: ReactNode;
}) {
	const { t } = useTranslation("workspace");
	const diagram = Children.toArray(children).some(
		(child) =>
			isValidElement<{ className?: string }>(child) &&
			/language-(mermaid|plantuml|dot)\b/.test(child.props.className ?? ""),
	);
	return (
		<MarkdownExpandable label={t(diagram ? "markdown.diagram" : "markdown.code")}>
			<pre
				{...props}
				data-source-line={node?.position?.start.line}
				data-source-end-line={node?.position?.end.line}
			>
				{children}
			</pre>
		</MarkdownExpandable>
	);
}

export type MarkdownBookmark = { text: string; tag: string; offset: number; scrollTop: number };
const sourceBlocks = Object.fromEntries(
	["h1", "h2", "h3", "h4", "h5", "h6", "p", "tr", "li", "blockquote", "hr"].map((tag) => [
		tag,
		({
			node,
			children,
			...props
		}: {
			node?: { position?: { start: { line: number }; end: { line: number } } };
			children?: ReactNode;
		}) =>
			createElement(
				tag,
				{
					...props,
					"data-source-line": node?.position?.start.line,
					"data-source-end-line": node?.position?.end.line,
				},
				children,
			),
	]),
);

/** Prefer the smallest rendered blocks; a table range can target individual rows. */
function navigationTargets(container: HTMLElement, line: number, endLine: number): HTMLElement[] {
	const blocks = [...container.querySelectorAll<HTMLElement>("[data-source-line]")];
	const overlaps = blocks.filter(
		(block) => Number(block.dataset.sourceLine) <= endLine && Number(block.dataset.sourceEndLine) >= line,
	);
	if (overlaps.length) {
		const ancestors = new Set<HTMLElement>();
		for (const block of overlaps)
			for (let parent = block.parentElement; parent && parent !== container; parent = parent.parentElement)
				ancestors.add(parent);
		return overlaps.filter((block) => !ancestors.has(block));
	}
	// Blank lines, reference definitions and out-of-file requests have no rendered node.
	// Reveal the closest visible block instead of silently leaving the document at the top.
	const nearest = blocks.sort((a, b) => {
		const distance = (block: HTMLElement) =>
			Math.max(Number(block.dataset.sourceLine) - endLine, line - Number(block.dataset.sourceEndLine), 0);
		return distance(a) - distance(b);
	})[0];
	return nearest ? [nearest] : [];
}

export function MarkdownPreview({
	content,
	project,
	path,
	onCopyLink,
	restorePosition,
	navigation,
}: {
	navigation?: { line?: number; endLine?: number; navigationId?: string };
	restorePosition?: MarkdownBookmark;
	content: string;
	project: string;
	path: string;
	onCopyLink: (href: string) => void;
}) {
	const { t } = useTranslation("workspace");
	const scroll = useRef<HTMLDivElement>(null);
	const anchor = useRef<MarkdownBookmark | null>(restorePosition ?? null);
	const capturePosition = (): void => {
		const container = scroll.current;
		if (!container) return;
		const top = container.getBoundingClientRect().top;
		const blocks = [...container.querySelectorAll("h1,h2,h3,h4,h5,h6,p,pre,table,li")];
		const visible = blocks.find((block) => block.getBoundingClientRect().bottom > top);
		anchor.current = visible
			? {
					text: visible.textContent ?? "",
					tag: visible.tagName,
					offset: visible.getBoundingClientRect().top - top,
					scrollTop: container.scrollTop,
				}
			: null;
	};
	useLayoutEffect(() => {
		const container = scroll.current;
		const saved = anchor.current;
		if (container && saved) {
			const candidates = [...container.querySelectorAll(saved.tag)].filter(
				(block) => block.textContent === saved.text,
			);
			const top = container.getBoundingClientRect().top;
			const target = candidates.sort(
				(a, b) =>
					Math.abs(a.getBoundingClientRect().top - top + container.scrollTop - saved.scrollTop) -
					Math.abs(b.getBoundingClientRect().top - top + container.scrollTop - saved.scrollTop),
			)[0];
			if (target) container.scrollTop += target.getBoundingClientRect().top - top - saved.offset;
			else container.scrollTop = saved.scrollTop;
		}
		capturePosition();
	}, [content]);
	const lastNavigation = useRef<string | null>(null);
	const line = navigation?.line;
	const endLine = navigation?.endLine ?? line;
	const navigationId = navigation?.navigationId;
	useLayoutEffect(() => {
		const container = scroll.current;
		if (!container || !line || !endLine) {
			lastNavigation.current = null;
			return;
		}
		const targets = navigationTargets(container, line, endLine);
		for (const target of targets) target.setAttribute("data-navigation-target", "true");
		const request = JSON.stringify([line, endLine, navigationId]);
		if (targets[0] && lastNavigation.current !== request && !restorePosition) {
			container.scrollTop +=
				targets[0].getBoundingClientRect().top - container.getBoundingClientRect().top - 24;
			capturePosition();
		}
		lastNavigation.current = request;
		return () => {
			for (const target of targets) target.removeAttribute("data-navigation-target");
		};
	}, [line, endLine, navigationId, content, restorePosition]);
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
	const rendered = (
		<Markdown
			remarkPlugins={[remarkGfm]}
			rehypePlugins={[rehypeRaw, rehypeSanitize]}
			components={{
				...sourceBlocks,
				table: MarkdownTable,
				pre: MarkdownCodeBlock,
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
	);
	return (
		<MarkdownExpansion revision={content}>
			<div
				ref={scroll}
				onScroll={capturePosition}
				className="markdown-scroll"
				data-testid="markdown-preview"
				role="region"
				aria-label={line ? t("markdown.targetLines", { start: line, end: endLine }) : t("viewer.markdown")}
			>
				<div className="markdown-preview-actions">
					<MarkdownExpandButton content={rendered} label={t("viewer.markdown")} wholeDocument />
				</div>
				<article className="markdown-preview">{rendered}</article>
			</div>
		</MarkdownExpansion>
	);
}
