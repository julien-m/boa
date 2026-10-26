/** On-demand source search opens a result at its original line. */
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import type { Selection } from "./models";
import { SearchInput } from "./search-input";

export function ProjectSearch({
	project,
	onOpen,
}: {
	project: string;
	onOpen: (selection: Selection) => void;
}) {
	const { t } = useTranslation("workspace");
	const [input, setInput] = useState("");
	const [query, setQuery] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const results = useQuery({
		queryKey: ["search", project, query],
		queryFn: () => api.search(project, query),
		enabled: query.length > 0,
		staleTime: 0,
	});
	useEffect(() => {
		inputRef.current?.focus();
	}, []);
	return (
		<div className="project-search" data-testid="project-search">
			<form
				onSubmit={(event) => {
					event.preventDefault();
					if (input.trim() === query) {
						void results.refetch();
					} else {
						setQuery(input.trim());
					}
				}}
			>
				<label htmlFor="project-search-input">{t("search.label")}</label>
				<div className="search-input-row">
					<SearchInput
						inputRef={inputRef}
						id="project-search-input"
						data-testid="project-search-input"
						placeholder={t("search.placeholder")}
						value={input}
						onClear={() => {
							setInput("");
							setQuery("");
						}}
						onChange={(event) => {
							setInput(event.target.value);
							if (!event.target.value) setQuery("");
						}}
					/>
					<button
						type="submit"
						className="icon-button"
						data-testid="project-search-submit"
						aria-label={t("search.submit")}
					>
						<Search size={14} />
					</button>
				</div>
			</form>
			<p className="small muted">{t("search.description")}</p>
			{results.isFetching && <p className="inline-status">{t("search.loading")}</p>}
			{results.error && <p className="inline-error">{String(results.error)}</p>}
			{results.data && (
				<>
					<p className="small muted">
						{t("search.results", { count: results.data.matches.length })}
						{results.data.limited ? t("search.limited") : ""}
					</p>
					{results.data.warning && <p className="inline-error">{results.data.warning}</p>}
					<div className="search-results">
						{results.data.matches.map((match, index) => (
							<button
								type="button"
								key={`${match.path}:${match.line}:${index}`}
								data-testid={`search-result-${index}`}
								onClick={() =>
									onOpen({
										project,
										path: match.path,
										line: match.line,
										endLine: match.line,
										navigationId: crypto.randomUUID(),
									})
								}
							>
								<strong>
									{match.path}
									<span>{t("search.line", { line: match.line })}</span>
								</strong>
								<code>{match.text}</code>
							</button>
						))}
					</div>
				</>
			)}
		</div>
	);
}
