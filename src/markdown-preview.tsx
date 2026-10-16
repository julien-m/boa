/** Read-only Markdown document; remote resources never load automatically. */
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownPreview({
	content,
	onCopyLink,
}: {
	content: string;
	onCopyLink: (href: string) => void;
}) {
	const { t } = useTranslation("workspace");
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
						img: ({ alt }) => (
							<span className="markdown-image">
								{t("markdown.image", { alt: alt || t("markdown.noDescription") })}
							</span>
						),
					}}
				>
					{content}
				</Markdown>
			</article>
		</div>
	);
}
