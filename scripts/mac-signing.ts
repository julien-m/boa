/** Local signing policy. The private key stays in the user's macOS Keychain. */
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const profilePath = join(homedir(), "Library/Application Support/local-app-signing/identity.json");
const bundleId = "com.julienm.boa";
const builtApp = "src-tauri/target/release/bundle/macos/BOA.app";
function run(command: string, args: string[]) {
	return execFileSync(command, args, {
		encoding: "utf8",
		timeout: 30_000,
		stdio: ["ignore", "pipe", "pipe"],
	});
}
export function identityFromProfile(value: unknown, available: string): string {
	if (
		typeof value !== "object" ||
		value === null ||
		!("identity" in value) ||
		typeof value.identity !== "string" ||
		!/^[0-9a-f]{40}$/i.test(value.identity)
	)
		throw new Error("Signing profile requires an exact certificate SHA-1 fingerprint.");
	const identity = value.identity.toUpperCase();
	if (
		!available.split("\n").some(
			(line) =>
				line
					.trim()
					.match(/^\d+\)\s+([0-9a-f]{40})\s+"/i)?.[1]
					?.toUpperCase() === identity,
		)
	)
		throw new Error(
			"Configured signing identity is unavailable or expired. Unlock the login Keychain or renew/configure the certificate; no ad-hoc fallback is allowed.",
		);
	return identity;
}
function localIdentity() {
	if (!existsSync(profilePath))
		throw new Error(
			"Configure a stable local identity first: bun run mac:signing -- <certificate-SHA1>. Use --adhoc only for disposable build artifacts.",
		);
	return identityFromProfile(
		JSON.parse(readFileSync(profilePath, "utf8")),
		run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]),
	);
}
function configure(identity: string) {
	const validated = identityFromProfile(
		{ identity },
		run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]),
	);
	mkdirSync(dirname(profilePath), { recursive: true, mode: 0o700 });
	const temporary = `${profilePath}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ identity: validated }, null, 2)}\n`, {
		mode: 0o600,
		flag: "wx",
	});
	renameSync(temporary, profilePath);
	console.log(
		`Configured shared local signing profile: ${profilePath}. No private key was exported. Key access is checked when signing.`,
	);
}
function appMetadata(app: string) {
	const plist = join(app, "Contents/Info.plist");
	const id = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist]).trim();
	const executable = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", plist]).trim();
	if (id !== bundleId || executable !== "boa")
		throw new Error("Expected the BOA application bundle and executable.");
}
export function requirement(app: string) {
	const result = spawnSync("/usr/bin/codesign", ["--display", "--requirements", "-", app], {
		encoding: "utf8",
		timeout: 10_000,
	});
	if (result.error) throw result.error;
	const expression = result.stdout.match(/^(?:# )?designated => (.+)$/m)?.[1];
	if (result.status !== 0 || !expression)
		throw new Error(`Cannot read application signing requirement: ${result.stderr}`);
	return expression;
}
function verify(app: string, expression?: string) {
	run("/usr/bin/codesign", [
		"--verify",
		"--deep",
		"--strict",
		...(expression ? [`-R=${expression}`] : []),
		app,
	]);
}
export function compatibleUpdate(previous: string, staged: string) {
	const old = requirement(previous);
	if (/\bcdhash\b/.test(old)) return false; // One-time migration from an ad-hoc build.
	verify(staged, old);
	verify(previous, requirement(staged));
	return true;
}
function assertNotRunning(app: string) {
	if (!existsSync(app)) return;
	const executable = join(realpathSync(app), "Contents/MacOS/boa");
	const escaped = executable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const result = spawnSync("/usr/bin/pgrep", ["-f", `^${escaped}([[:space:]]|$)`], {
		encoding: "utf8",
		timeout: 5_000,
	});
	if (result.error) throw result.error;
	if (result.status === 0)
		throw new Error("Quit BOA before installing an update; unsaved drafts must be preserved.");
	if (result.status !== 1) throw new Error("Unable to check whether BOA is running.");
}
export function installBundle(source: string, destination: string, identity: string) {
	source = realpathSync(source);
	destination = resolve(destination);
	appMetadata(source);
	verify(source);
	if (existsSync(destination)) {
		if (lstatSync(destination).isSymbolicLink())
			throw new Error("Refusing to replace a symlinked application.");
		appMetadata(destination);
		verify(destination);
	}
	assertNotRunning(destination);
	mkdirSync(dirname(destination), { recursive: true });
	const workspace = mkdtempSync(join(dirname(destination), ".boa-install-"));
	const staged = join(workspace, "BOA.app");
	const backup = join(workspace, "previous.app");
	let previousMoved = false;
	let installed = false;
	try {
		run("/usr/bin/ditto", [source, staged]);
		run("/usr/bin/codesign", [
			"--force",
			"--sign",
			identity,
			"--timestamp=none",
			"--identifier",
			bundleId,
			"--preserve-metadata=entitlements,flags,runtime",
			staged,
		]);
		verify(staged);
		if (/\bcdhash\b/.test(requirement(staged)))
			throw new Error("A stable certificate signature is required for installation.");
		if (existsSync(destination) && !compatibleUpdate(destination, staged))
			console.log(
				"First stable signature: macOS may ask once more for Documents access. Later updates must retain this identity.",
			);
		assertNotRunning(destination);
		if (existsSync(destination)) {
			renameSync(destination, backup);
			previousMoved = true;
		}
		renameSync(staged, destination);
		verify(destination);
		const expression = requirement(destination);
		installed = true;
		return expression;
	} catch (error) {
		if (previousMoved) {
			if (existsSync(destination)) run("/usr/bin/trash", [destination]);
			renameSync(backup, destination);
			previousMoved = false;
		}
		throw error;
	} finally {
		// Never dispose of the backup if rollback failed.
		if (!previousMoved || installed) {
			try {
				run("/usr/bin/trash", [workspace]);
			} catch {
				console.warn(`Temporary bundle retained for recoverable cleanup: ${workspace}`);
			}
		} else console.error(`Previous application retained for recovery: ${backup}`);
	}
}
export function installationDestination(userHome = homedir(), systemApp = "/Applications/BOA.app") {
	if (existsSync(systemApp))
		throw new Error(
			`Found a legacy installation at ${systemApp}. Quit BOA, then use Finder to move that application to ~/Applications/BOA.app (preserve the old copy if both locations exist). Remove the duplicate from /Applications and update Dock shortcuts before running mac:install again. No application was changed.`,
		);
	return join(userHome, "Applications/BOA.app");
}
async function main(args: string[]) {
	if (process.platform !== "darwin") throw new Error("Local app signing requires macOS.");
	const [command, ...raw] = args;
	const options = raw[0] === "--" ? raw.slice(1) : raw;
	if (command === "configure" && options.length === 1) return configure(options[0]);
	if (command === "build" && (options.length === 0 || (options.length === 1 && options[0] === "--adhoc"))) {
		const identity = options[0] === "--adhoc" ? "-" : localIdentity();
		const child = Bun.spawn(["bunx", "tauri", "build", "--bundles", "app"], {
			env: { ...process.env, APPLE_SIGNING_IDENTITY: identity },
			stdout: "inherit",
			stderr: "inherit",
		});
		process.exitCode = await child.exited;
		return;
	}
	if (command === "install" && options.length <= 1) {
		const expression = installBundle(options[0] ?? builtApp, installationDestination(), localIdentity());
		console.log(`Installed BOA with stable identity. Designated requirement: ${expression}`);
		return;
	}
	throw new Error("Usage: mac-signing.ts configure <certificate-SHA1> | build [--adhoc] | install [BOA.app]");
}
if (import.meta.main)
	main(process.argv.slice(2)).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
