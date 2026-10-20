import { useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { type FileHit, fileWorkspace } from "./file-workspace-api";
import { useFileLabels } from "./file-workspace-labels";
export function FileSearchPanel({
	roots,
	mode = "all",
	onOpen,
	onClose,
	initialInput = "",
	live = false,
}: {
	roots: string[];
	initialInput?: string;
	live?: boolean;
	mode?: "paths" | "all";
	onOpen: (hit: FileHit) => void;
	onClose: () => void;
}) {
	const l = useFileLabels();
	const [input, setInput] = useState(initialInput);
	const [query, setQuery] = useState("");
	const [kind, setKind] = useState<"paths" | "content" | "all">(mode);
	useEffect(() => {
		if (!live) return;
		const timer = setTimeout(() => setQuery(input.trim()), 180);
		return () => clearTimeout(timer);
	}, [input, live]);
	const result = useQuery({
		queryKey: ["file-search", ...roots, query, kind],
		queryFn: () => fileWorkspace.search(roots, query, kind),
		enabled: !!query,
		retry: false,
		staleTime: 0,
	});
	return (
		<section
			className={`file-search-panel ${live ? "tree-speed-search" : ""}`}
			data-testid="file-search-panel"
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.stopPropagation();
					onClose();
				}
			}}
		>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					if (!input.trim()) setQuery("");
					else if (query === input.trim()) void result.refetch();
					else setQuery(input.trim());
				}}
			>
				{!live && <Search size={14} />}
				<input
					autoFocus
					aria-label={l.search}
					placeholder={live ? l.typeToFilter : l.searchHint}
					value={input}
					onChange={(e) => setInput(e.target.value)}
				/>
				<button type="button" className="icon-button" aria-label={l.close} onClick={onClose}>
					<X size={14} />
				</button>
			</form>
			{!live && (
				<select aria-label={l.search} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
					<option value="paths">{l.paths}</option>
					<option value="content">{l.content}</option>
					<option value="all">{l.both}</option>
				</select>
			)}
			{result.isFetching && <p className="muted">{l.loading}</p>}
			{result.error && <p role="alert">{String(result.error)}</p>}
			{result.data && (
				<>
					<p className="muted">
						{result.data.matches.length} {l.results}
						{result.data.limited ? ` · ${l.limited}` : ""}
					</p>
					{result.data.warning && <p role="alert">{result.data.warning}</p>}
					<div className="search-results">
						{result.data.matches.map((hit, i) => (
							<button
								type="button"
								key={`${hit.project}:${hit.path}:${hit.line}:${i}`}
								onClick={() => onOpen(hit)}
								data-hint={`${hit.project}/${hit.path}`}
							>
								<strong>
									{hit.directory ? "▸ " : ""}
									{hit.path}
									{hit.line > 0 ? `:${hit.line}` : ""}
								</strong>
								{hit.text && <code>{hit.text}</code>}
								<small className="muted">{hit.project}</small>
							</button>
						))}
					</div>
					{!result.data.matches.length && <p>{l.noResults}</p>}
				</>
			)}
		</section>
	);
}
