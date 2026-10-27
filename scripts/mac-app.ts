/** Resolve the stable macOS installation, never a development URL-handler copy. */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Ignore development copies registered for boa:// by Launch Services. */
export function installedBoaApp(
	candidates = [join(homedir(), "Applications", "BOA.app"), "/Applications/BOA.app"],
): string {
	const app = candidates.find((path) => existsSync(path) && statSync(path).isDirectory());
	if (!app) throw new Error("Install BOA.app in ~/Applications or /Applications first");
	return app;
}

export function launchBoa(): void {
	const result = spawnSync("/usr/bin/open", ["-a", installedBoaApp()], { encoding: "utf8", timeout: 10000 });
	if (result.error || result.status !== 0)
		throw new Error(result.error?.message || result.stderr || "Unable to open BOA");
}
