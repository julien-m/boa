import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { type ContextView, contextApi } from "./context-api";
import { ContextExplanation, ContextSidebar } from "./context-views";
import { setInterfaceLanguage } from "./i18n";

const view: ContextView = {
	id: "saved-view",
	project: "/fixture",
	title: "A flow <script>example</script>",
	description: "Follow the selected source.",
	kind: "findings",
	steps: [
		{
			id: "selected-step",
			title: "Validate the input",
			description: "Inspect source and guard.",
			passages: ["cause", "guard"].map((role, index) => ({
				id: role,
				path: `src/${role}.ts`,
				startLine: index + 1,
				endLine: index + 1,
				role,
			})),
		},
	],
	revision: 1,
	updatedAt: 0,
};

afterEach(async () => {
	vi.restoreAllMocks();
	await setInterfaceLanguage("fr");
});

it("renders saved contexts as explicit navigation choices without opening their source", async () => {
	await setInterfaceLanguage("en");
	const client = new QueryClient();
	client.setQueryData(["context-views", view.project], [view]);
	const open = vi.fn();
	const apiOpen = vi.spyOn(contextApi, "open");
	const html = renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<ContextSidebar project={view.project} active={null} onOpen={open} />
		</QueryClientProvider>,
	);
	expect(html).toContain("Open step");
	expect(html).toContain("&lt;script&gt;example&lt;/script&gt;");
	expect(html).not.toContain("<script>");
	expect(open).not.toHaveBeenCalled();
	expect(apiOpen).not.toHaveBeenCalled();
	client.clear();
});

it("shows linked evidence, uncertain anchors and return controls in both interface languages", async () => {
	for (const language of ["en", "fr"]) {
		await setInterfaceLanguage(language);
		const html = renderToStaticMarkup(
			<ContextExplanation
				view={view}
				step={view.steps[0]}
				passageId={view.steps[0].passages[0].id}
				status="needs-review"
				onOpen={() => {}}
				onReturn={() => {}}
			/>,
		);
		for (const passage of view.steps[0].passages) expect(html).toContain(passage.path);
		expect(html).toContain(language === "en" ? "Needs review" : "À revérifier");
		expect(html).toContain(language === "en" ? "Back to my reading" : "Revenir à ma lecture");
		expect(html).toContain("disabled");
	}
});
