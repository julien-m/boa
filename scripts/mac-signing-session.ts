/** Native signing transport. This module never reads or accepts the keychain password. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(new URL("./mac-keychain.swift", import.meta.url));
const preparedPath = fileURLToPath(new URL("../work/autonomous-signing/boa-signing-helper", import.meta.url));
const localDirectory = join(homedir(), "Library/Application Support/local-app-signing");
export const candidatePath = join(localDirectory, "autonomous-candidate.json");
export const activePath = join(localDirectory, "identity.json");
const receiptPath = join(localDirectory, "acceptance-locked.json");
const entry = "local-app-signing/local/keychain-password";

export interface AutonomousProfile {
	version: 2;
	identity: string;
	keychainPath: string;
	credentialEntry: string;
	helperPath: string;
	helperSHA256: string;
	sourceSHA256: string;
	enabled: boolean;
}

interface NativeResult {
	action?: string;
	relocked?: boolean;
	identity?: string;
	locked?: boolean | null;
	screenLockedAtStart?: boolean | null;
	screenLockedAtEnd?: boolean | null;
	[key: string]: unknown;
}

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

/** Validate the persisted non-secret contract; malformed v2 profiles must never fall back to legacy signing. */
export function autonomousProfile(value: unknown): AutonomousProfile | undefined {
	if (typeof value !== "object" || value === null || !("version" in value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.version !== 2 ||
		typeof record.identity !== "string" ||
		!/^[A-F0-9]{40}$/.test(record.identity) ||
		record.credentialEntry !== entry ||
		typeof record.enabled !== "boolean" ||
		!["keychainPath", "helperPath"].every(
			(key) => typeof record[key] === "string" && isAbsolute(record[key] as string),
		) ||
		!["helperSHA256", "sourceSHA256"].every(
			(key) => typeof record[key] === "string" && /^[a-f0-9]{64}$/.test(record[key] as string),
		)
	)
		throw new Error("INVALID_AUTONOMOUS_PROFILE: no legacy or ad-hoc fallback.");
	return record as unknown as AutonomousProfile;
}

function privateFile(path: string): void {
	const info = lstatSync(path);
	if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)
		throw new Error("UNSAFE_LOCAL_SIGNING_FILE");
}

/** Read an explicitly opted-in local profile. No secret values are stored in this format. */
export function readAutonomous(path = activePath): AutonomousProfile | undefined {
	if (!existsSync(path)) return undefined;
	if (!statSync(path).isFile()) throw new Error("UNSAFE_LOCAL_SIGNING_FILE");
	const profile = autonomousProfile(JSON.parse(readFileSync(path, "utf8")));
	if (profile) privateFile(path);
	return profile;
}

function nativeEnvironment(): NodeJS.ProcessEnv {
	return { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: homedir(), TMPDIR: tmpdir() };
}

function terminalSettings(argument: string): string {
	const result = spawnSync("/bin/stty", ["-f", "/dev/tty", argument], {
		encoding: "utf8",
		timeout: 2_000,
		killSignal: "SIGKILL",
	});
	if (result.error || result.status !== 0) throw new Error("TTY_SETTINGS_FAILED");
	return result.stdout.trim();
}

/** Execute a fixed management command with a hard kill deadline; no secret is ever passed through this transport. */
export function runSigningCommand(program: string, args: string[], timeout = 10_000, interactive = false) {
	const savedTerminal = interactive ? terminalSettings("-g") : null;
	try {
		const result = spawnSync(program, args, {
			timeout,
			killSignal: "SIGKILL",
			encoding: "utf8",
			env: nativeEnvironment(),
			stdio: interactive ? "inherit" : ["ignore", "pipe", "pipe"],
		});
		if (result.error || result.status !== 0) {
			const code = result.stderr?.trim().match(/^[A-Z][A-Z_]+(?: -?\d+)?$/)?.[0];
			throw new Error(
				code ?? (result.error ? "SIGNING_COMMAND_TIMEOUT_OR_START_FAILURE" : "SIGNING_COMMAND_FAILED"),
			);
		}
		return result;
	} finally {
		// A hard timeout can kill the password prompt before it restores echo.
		if (savedTerminal !== null) terminalSettings(savedTerminal);
	}
}

/** Compile a disposable helper candidate only; do not access signing material or modify the local profile. */
export function prepareHelper(): void {
	mkdirSync(dirname(preparedPath), { recursive: true, mode: 0o700 });
	const temporary = `${preparedPath}.${process.pid}.next`;
	try {
		runSigningCommand(
			"/usr/bin/xcrun",
			[
				"swiftc",
				"-suppress-warnings",
				"-module-cache-path",
				join(dirname(preparedPath), "module-cache"),
				sourcePath,
				"-o",
				temporary,
			],
			90_000,
		);
		chmodSync(temporary, 0o700);
		renameSync(temporary, preparedPath);
		writeFileSync(
			`${preparedPath}.json`,
			JSON.stringify({
				sourceSHA256: sha256(readFileSync(sourcePath)),
				helperSHA256: sha256(readFileSync(preparedPath)),
			}),
			{ mode: 0o600 },
		);
	} finally {
		rmSync(temporary, { force: true });
	}
	console.log("Native helper candidate compiled. No keychain or signing identity was accessed.");
}

function preparedHelper(): string {
	privateFile(preparedPath);
	const receipt = JSON.parse(readFileSync(`${preparedPath}.json`, "utf8"));
	if (
		receipt.sourceSHA256 !== sha256(readFileSync(sourcePath)) ||
		receipt.helperSHA256 !== sha256(readFileSync(preparedPath))
	)
		throw new Error("HELPER_PREPARATION_STALE: run mac:signing -- prepare.");
	return preparedPath;
}

function writeProfile(path: string, profile: AutonomousProfile): void {
	const temporary = `${path}.${process.pid}.next`;
	writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	try {
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function candidate(): AutonomousProfile {
	const profile = readAutonomous(candidatePath);
	if (!profile || profile.enabled)
		throw new Error("PROVISIONING_REQUIRED: run mac:signing -- provision in your own Terminal.");
	return profile;
}

function native(
	action: string,
	path: string,
	profile: AutonomousProfile,
	extra: string[] = [],
): NativeResult {
	privateFile(profile.helperPath);
	if (
		sha256(readFileSync(profile.helperPath)) !== profile.helperSHA256 ||
		sha256(readFileSync(sourcePath)) !== profile.sourceSHA256
	)
		throw new Error("HELPER_CHANGED: re-provision explicitly; no fallback.");
	const output = runSigningCommand(
		profile.helperPath,
		[action, path, ...extra],
		action === "screen" ? 2_000 : 135_000,
	).stdout;
	const result: NativeResult = JSON.parse(output);
	if (
		(action === "sign" || action === "doctor") &&
		(result.relocked !== true || result.identity !== profile.identity)
	)
		throw new Error("NATIVE_SIGNING_RECEIPT_INVALID");
	return result;
}

/** Initial attended setup. Password entry happens only in the native helper's own masked /dev/tty prompt. */
export function provisionHelper(
	keychainPath = join(homedir(), "Library/Keychains/local-app-signing.keychain-db"),
): void {
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error("INTERACTIVE_TERMINAL_REQUIRED: run this command yourself in Terminal.");
	const prepared = preparedHelper();
	privateFile(activePath);
	const previous = JSON.parse(readFileSync(activePath, "utf8"));
	if (previous.version !== undefined)
		throw new Error("AUTONOMOUS_PROFILE_ALREADY_CONFIGURED: keep the existing helper and receipts.");
	if (typeof previous.identity !== "string" || !/^[a-f0-9]{40}$/i.test(previous.identity))
		throw new Error("EXACT_SIGNING_IDENTITY_REQUIRED");
	mkdirSync(localDirectory, { recursive: true, mode: 0o700 });
	const directoryInfo = lstatSync(localDirectory);
	if (
		!directoryInfo.isDirectory() ||
		directoryInfo.isSymbolicLink() ||
		directoryInfo.uid !== process.getuid?.() ||
		(directoryInfo.mode & 0o077) !== 0
	)
		throw new Error("PRIVATE_SIGNING_DIRECTORY_REQUIRED");
	const helperPath = join(localDirectory, "boa-signing-helper");
	let profile = readAutonomous(candidatePath);
	if (profile) {
		if (
			profile.identity !== previous.identity.toUpperCase() ||
			profile.sourceSHA256 !== sha256(readFileSync(sourcePath)) ||
			profile.keychainPath !== resolve(keychainPath)
		)
			throw new Error("EXISTING_CANDIDATE_MISMATCH: inspect before replacing any local setup.");
	} else {
		if (existsSync(helperPath))
			throw new Error("HELPER_ALREADY_EXISTS: inspect before replacing any local helper.");
		profile = {
			version: 2,
			identity: previous.identity.toUpperCase(),
			keychainPath: resolve(keychainPath),
			credentialEntry: entry,
			helperPath,
			helperSHA256: "0".repeat(64),
			sourceSHA256: sha256(readFileSync(sourcePath)),
			enabled: false,
		};
		writeProfile(candidatePath, profile);
	}
	console.log(
		"Initial setup only: two masked password entries. codesign may request one explicit key authorization; choose Always Allow for that key.",
	);
	if (!existsSync(helperPath)) {
		runSigningCommand(prepared, ["bootstrap", candidatePath], 150_000, true);
		profile.helperSHA256 = sha256(readFileSync(helperPath));
		writeProfile(candidatePath, profile);
	}
	if (profile.helperSHA256 === "0".repeat(64) && existsSync(helperPath)) {
		runSigningCommand("/usr/bin/codesign", [
			"--verify",
			"--strict",
			`-R=identifier "com.boa.local-signing" and certificate leaf = H"${profile.identity}"`,
			helperPath,
		]);
		profile.helperSHA256 = sha256(readFileSync(helperPath));
		writeProfile(candidatePath, profile);
	}
	if (profile.helperSHA256 !== sha256(readFileSync(helperPath))) throw new Error("HELPER_CHANGED");
	runSigningCommand(helperPath, ["provision", candidatePath], 135_000, true);
	console.log(
		"Provisioning completed; autonomous build/install remain disabled until the locked-screen acceptance is confirmed.",
	);
}

/** Sign only a disposable/staged BOA bundle; native validation and re-locking must both succeed. */
export function autonomousSign(bundle: string, profile: AutonomousProfile, path = activePath): NativeResult {
	return native("sign", path, profile, [resolve(bundle)]);
}

function requirements(bundle: string): { requirement: string; hash: string } {
	const req = runSigningCommand("/usr/bin/codesign", [
		"--display",
		"--requirements",
		"-",
		bundle,
	]).stdout.match(/^(?:# )?designated => (.+)$/m)?.[1];
	const hash = runSigningCommand("/usr/bin/codesign", ["-dv", "--verbose=4", bundle]).stderr.match(
		/^CDHash=(.+)$/m,
	)?.[1];
	if (!req || !hash || /\bcdhash\b/.test(req)) throw new Error("STABLE_REQUIREMENT_EXPECTED");
	return { requirement: req, hash };
}

function fixture(root: string, version: number): string {
	const app = join(root, String(version), "BOA.app");
	mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
	writeFileSync(
		join(app, "Contents/Info.plist"),
		`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.julienm.boa</string><key>CFBundleExecutable</key><string>boa</string><key>CFBundleVersion</key><string>${version}</string></dict></plist>`,
	);
	const source = join(root, `probe-${version}.c`);
	writeFileSync(source, `int main(void) { return ${version}; }\n`);
	runSigningCommand("/usr/bin/xcrun", ["clang", source, "-o", join(app, "Contents/MacOS/boa")]);
	return app;
}

/** Bounded screen observer, advisory only. Human confirmation is required separately before activation. */
export async function waitForScreenLock(sample: () => boolean | null, limit = 120_000): Promise<void> {
	const deadline = performance.now() + limit;
	while (performance.now() < deadline) {
		if (sample() === true) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("SCREEN_LOCK_NOT_CONFIRMED: no signing was started.");
}

/** Verify two temporary signatures; installed applications and existing settings are never used as fixtures. */
export async function acceptance(waitForLock: boolean): Promise<void> {
	const profile = candidate();
	const root = mkdtempSync(join(tmpdir(), "boa-signing-acceptance-"));
	const configHash = sha256(readFileSync(candidatePath));
	try {
		const apps = [fixture(root, 1), fixture(root, 2)];
		native("doctor", candidatePath, profile);
		if (waitForLock) {
			console.log(
				"Ready: lock your screen now. The signing requests start only after the lock signal; do not unlock until completion.",
			);
			await waitForScreenLock(() => native("screen", candidatePath, profile).locked ?? null);
		}
		const receipts = apps.map((app) => autonomousSign(app, profile, candidatePath));
		if (
			waitForLock &&
			!receipts.every((receipt) => receipt.screenLockedAtStart === true && receipt.screenLockedAtEnd === true)
		)
			throw new Error("SCREEN_UNLOCKED_DURING_ACCEPTANCE");
		const signed = apps.map(requirements);
		if (signed[0].requirement !== signed[1].requirement || signed[0].hash === signed[1].hash)
			throw new Error("REQUIREMENT_CONTINUITY_FAILED");
		for (const app of apps)
			runSigningCommand("/usr/bin/codesign", [
				"--verify",
				"--deep",
				"--strict",
				`-R=${signed[0].requirement}`,
				app,
			]);
		const receipt = {
			version: 1,
			configHash,
			identity: profile.identity,
			helperSHA256: profile.helperSHA256,
			screenLocked: waitForLock,
			advisoryScreenSignal: true,
			humanConfirmationRequired: true,
			twoDistinctBuilds: true,
			relocked: true,
			completedAt: new Date().toISOString(),
		};
		const file = waitForLock ? receiptPath : join(localDirectory, "acceptance-normal.json");
		writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
		console.log(
			"PASS: two temporary bundles signed and verified; vault re-locked after each. No installed application changed.",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** Activate only an unchanged candidate backed by locked-screen proof and an explicit human attestation. */
export function activate(confirmNoInteraction: boolean): void {
	if (!confirmNoInteraction)
		throw new Error("CONFIRMATION_REQUIRED: after reviewing the test, use --confirm-no-interaction.");
	const profile = candidate();
	privateFile(receiptPath);
	const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
	validateActivationReceipt(receipt, sha256(readFileSync(candidatePath)), profile);
	native("doctor", candidatePath, profile);
	const old = JSON.parse(readFileSync(activePath, "utf8"));
	if (old.version !== undefined || old.identity?.toUpperCase() !== profile.identity)
		throw new Error("ACTIVE_PROFILE_CHANGED");
	const backup = join(localDirectory, "identity-before-autonomous.json");
	if (!existsSync(backup)) {
		copyFileSync(activePath, backup, 1);
		chmodSync(backup, 0o600);
	}
	writeProfile(activePath, { ...profile, enabled: true });
	console.log(
		"Autonomous signing enabled for this validated local session. Login must remain accessible and the Mac awake.",
	);
}

/** Validate proof binding separately so a stale/helper-mismatched receipt can never activate a new configuration. */
export function validateActivationReceipt(
	receipt: unknown,
	configHash: string,
	profile: AutonomousProfile,
): void {
	if (typeof receipt !== "object" || receipt === null) throw new Error("LOCKED_SCREEN_ACCEPTANCE_REQUIRED");
	const r = receipt as Record<string, unknown>;
	if (
		r.version !== 1 ||
		r.configHash !== configHash ||
		r.identity !== profile.identity ||
		r.helperSHA256 !== profile.helperSHA256 ||
		r.screenLocked !== true ||
		r.twoDistinctBuilds !== true ||
		r.relocked !== true
	)
		throw new Error("LOCKED_SCREEN_ACCEPTANCE_REQUIRED");
}

/** Route explicit management commands; legacy fingerprint configuration remains in mac-signing.ts. */
export async function sessionCommand(action: string, args: string[]): Promise<void> {
	if (action === "prepare" && args.length === 0) return prepareHelper();
	if (action === "provision" && args.length === 0) return provisionHelper();
	if (action === "doctor" && (args.length === 0 || args.join() === "--non-interactive")) {
		const profile = readAutonomous(activePath) ?? candidate();
		const path = profile.enabled ? activePath : candidatePath;
		console.log(JSON.stringify(native("doctor", path, profile)));
		return;
	}
	if (
		action === "acceptance" &&
		args.every((arg) => ["--non-interactive", "--wait-for-screen-lock"].includes(arg))
	)
		return acceptance(args.includes("--wait-for-screen-lock"));
	if (action === "activate" && args.join() === "--confirm-no-interaction") return activate(true);
	throw new Error(
		"Usage: mac:signing -- prepare | provision | doctor --non-interactive | acceptance --non-interactive [--wait-for-screen-lock] | activate --confirm-no-interaction | CERTIFICATE_SHA1",
	);
}
