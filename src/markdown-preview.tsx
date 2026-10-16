/** Read-only Markdown document; remote resources never load automatically. */
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownPreview({
	content,
	onCopyLink,
}: {
	content: string;
	onCopyLink: (href: string) => void;
}) {
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
								title="Copier le lien"
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
						img: ({ alt }) => <span className="markdown-image">Image : {alt || "sans description"}</span>,
					}}
				>
					{content}
				</Markdown>
			</article>
		</div>
	);
}
