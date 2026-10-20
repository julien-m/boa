// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ControlHints } from "./control-hints";
import { i18n } from "./i18n";

let host: HTMLDivElement, root: Root;
function Fixture() {
	const { t } = useTranslation("workspace");
	return (
		<>
			<ControlHints />
			<button type="button" aria-label={t("zoom.actual")} aria-describedby="existing">
				100 %
			</button>
			<dialog open>
				<button type="button" aria-label={t("markdown.closeExpanded")} aria-keyshortcuts="Escape">
					×
				</button>
			</dialog>
		</>
	);
}
beforeEach(async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	await i18n.changeLanguage("fr");
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root.render(<Fixture />));
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.useRealTimers();
	await i18n.changeLanguage("fr");
});
it("shows translated keyboard hints in the modal layer and preserves existing descriptions", async () => {
	const button = host.querySelector("button")!;
	await act(async () => button.focus());
	expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Taille réelle (100 %)");
	expect(button.getAttribute("aria-describedby")).toContain("existing");
	await act(async () => i18n.changeLanguage("en"));
	expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Actual size (100%)");
	await act(async () => host.querySelector<HTMLButtonElement>("dialog button")!.focus());
	expect(host.querySelector('dialog [role="tooltip"]')?.textContent).toBe("Close expanded view · Esc");
	expect(button.getAttribute("aria-describedby")).toBe("existing");
	await act(async () =>
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
	);
	expect(document.querySelector('[role="tooltip"]')).toBeNull();
});
it("delays pointer hints and dismisses them on leaving or clicking", async () => {
	vi.useFakeTimers();
	const button = host.querySelector("button")!;
	await act(async () => button.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
	expect(document.querySelector('[role="tooltip"]')).toBeNull();
	await act(async () => vi.advanceTimersByTime(350));
	expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
	await act(async () => button.dispatchEvent(new MouseEvent("pointerout", { bubbles: true })));
	expect(document.querySelector('[role="tooltip"]')).toBeNull();
	await act(async () => button.focus());
	await act(async () => button.click());
	expect(document.querySelector('[role="tooltip"]')).toBeNull();
});

it("shows a hint for disabled controls even when pointer events do not bubble", async () => {
	vi.useFakeTimers();
	const button = host.querySelector("button")!;
	button.disabled = true;
	await act(async () => button.dispatchEvent(new MouseEvent("pointerover", { bubbles: false })));
	await act(async () => vi.advanceTimersByTime(350));
	expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Taille réelle (100 %)");
});
