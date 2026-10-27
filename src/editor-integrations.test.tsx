// @vitest-environment happy-dom
import { invoke } from "@tauri-apps/api/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorIntegrations, type IntegrationStatus } from "./editor-integrations";
import { i18n } from "./i18n";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

let host: HTMLDivElement, root: Root;
let status: IntegrationStatus;
const mockedInvoke = vi.mocked(invoke);
const control = <T extends HTMLElement>(name: string) =>
	host.querySelector<T>(`[data-testid="integration-${name}"]`)!;

beforeEach(async () => {
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	await i18n.changeLanguage("fr");
	status = {
		installed: true,
		system: {
			extensions: [
				{ extensions: ["tsx"], configured: true },
				{ extensions: ["ts"], configured: false },
			],
		},
		codex: { available: true, configured: false },
		claude: { available: true, supported: false },
	};
	mockedInvoke.mockReset();
	mockedInvoke.mockImplementation(async (_command, args) => {
		const action = (args as { action: string }).action;
		return action === "status"
			? status
			: { status, restartRequired: action === "codex", changed: 1, failures: [] };
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
});

it("keeps extension changes local until Apply without refreshing or flashing loading", async () => {
	await act(async () => root.render(<EditorIntegrations />));
	expect(mockedInvoke.mock.calls).toEqual([["editor_integrations", { action: "status", extensions: [] }]]);
	expect(host.querySelector('input[type="checkbox"]')).toBeNull();
	await act(async () => control<HTMLButtonElement>("extensions").click());
	const ts = host.querySelector<HTMLInputElement>('[data-extension="ts"]')!;
	expect(host.querySelector<HTMLInputElement>('[data-extension="tsx"]')!.checked).toBe(true);
	await act(async () => ts.click());
	expect(mockedInvoke).toHaveBeenCalledTimes(1);
	expect(control("status").textContent).toBe("");
	expect(control<HTMLButtonElement>("extensions").getAttribute("aria-expanded")).toBe("true");
	await act(async () => control<HTMLButtonElement>("system").click());
	expect(mockedInvoke).toHaveBeenLastCalledWith("editor_integrations", {
		action: "system",
		extensions: ["tsx", "ts"],
	});
	expect(control("status").textContent).toContain("Associations macOS mises à jour");
}, 2000);

it("reports a saved Codex configuration and requests restart without relaunching the app", async () => {
	await act(async () => root.render(<EditorIntegrations />));
	await act(async () => control<HTMLButtonElement>("codex").click());
	expect(mockedInvoke).toHaveBeenLastCalledWith("editor_integrations", {
		action: "codex",
		extensions: ["tsx"],
	});
	expect(control("status").textContent).toContain("Configuration enregistrée. Redémarrez Codex");
	expect(mockedInvoke).toHaveBeenCalledTimes(2);
}, 2000);

it("requires an installed BOA and keeps status errors within the card", async () => {
	status.installed = false;
	await act(async () => root.render(<EditorIntegrations />));
	await act(async () => control<HTMLButtonElement>("extensions").click());
	expect(control<HTMLButtonElement>("system").disabled).toBe(true);
	expect(control<HTMLButtonElement>("codex").disabled).toBe(true);
	expect(host.textContent).toContain("Installez d’abord BOA");
}, 2000);

it("keeps a failed status check inline and offers retry", async () => {
	mockedInvoke.mockRejectedValueOnce(new Error("native transport unavailable"));
	await act(async () => root.render(<EditorIntegrations />));
	expect(host.querySelector('[role="alert"]')?.textContent).toContain("état des intégrations");
	expect(control<HTMLButtonElement>("extensions").disabled).toBe(true);
	expect(host.textContent).not.toContain("native transport unavailable");
	await act(async () =>
		[...host.querySelectorAll("button")].find((button) => button.textContent === "Réessayer")!.click(),
	);
	expect(control<HTMLButtonElement>("extensions").disabled).toBe(false);
}, 2000);

it("starts collapsed and toggles all extensions locally from partial, full and empty selections", async () => {
	await act(async () => root.render(<EditorIntegrations />));
	expect(control("extensions").getAttribute("aria-expanded")).toBe("false");
	expect(control("select-all")).toBeNull();
	await act(async () => control<HTMLButtonElement>("extensions").click());
	const checkboxes = () => [...host.querySelectorAll<HTMLInputElement>("[data-extension]")];
	expect(control("select-all").textContent).toBe("Tout sélectionner");
	await act(async () => control<HTMLButtonElement>("select-all").click());
	expect(checkboxes().every((input) => input.checked)).toBe(true);
	expect(control("select-all").textContent).toBe("Tout désélectionner");
	await act(async () => control<HTMLButtonElement>("select-all").click());
	expect(checkboxes().every((input) => !input.checked)).toBe(true);
	expect(control("select-all").textContent).toBe("Tout sélectionner");
	expect(control<HTMLButtonElement>("system").disabled).toBe(true);
	await act(async () => control<HTMLButtonElement>("select-all").click());
	await act(async () => control<HTMLButtonElement>("extensions").click());
	await act(async () => control<HTMLButtonElement>("extensions").click());
	expect(checkboxes().every((input) => input.checked)).toBe(true);
	expect(mockedInvoke).toHaveBeenCalledTimes(1);
	await act(async () => control<HTMLButtonElement>("system").click());
	expect(mockedInvoke).toHaveBeenLastCalledWith("editor_integrations", {
		action: "system",
		extensions: status.system.extensions.flatMap((item) => item.extensions),
	});
}, 2000);

it("shows linked extensions under one checkbox and applies the whole group", async () => {
	status.system.extensions = [{ extensions: ["html", "htm"], configured: false }];
	await act(async () => root.render(<EditorIntegrations />));
	await act(async () => control<HTMLButtonElement>("extensions").click());
	expect(host.querySelectorAll("[data-extension]")).toHaveLength(1);
	expect(host.textContent).toContain(".html / .htm");
	await act(async () => host.querySelector<HTMLInputElement>('[data-extension="html"]')!.click());
	expect(control("select-all").textContent).toBe("Tout désélectionner");
	expect(mockedInvoke).toHaveBeenCalledTimes(1);
	await act(async () => control<HTMLButtonElement>("system").click());
	expect(mockedInvoke).toHaveBeenLastCalledWith("editor_integrations", {
		action: "system",
		extensions: ["html", "htm"],
	});
}, 2000);
