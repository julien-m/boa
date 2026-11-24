import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	autonomousProfile,
	readAutonomous,
	runSigningCommand,
	validateActivationReceipt,
	waitForScreenLock,
} from "./mac-signing-session";

const profile = {
	version: 2 as const,
	identity: "A".repeat(40),
	keychainPath: "/tmp/example.keychain-db",
	credentialEntry: "local-app-signing/local/keychain-password",
	helperPath: "/tmp/example-helper",
	helperSHA256: "b".repeat(64),
	sourceSHA256: "c".repeat(64),
	enabled: false,
};

it("keeps legacy fingerprint profiles and rejects malformed autonomous profiles without fallback", () => {
	expect(autonomousProfile({ identity: profile.identity })).toBeUndefined();
	expect(autonomousProfile(profile)).toEqual(profile);
	for (const patch of [
		{ version: 3 },
		{ identity: "-" },
		{ identity: "codesign name" },
		{ helperPath: "relative" },
		{ keychainPath: "relative" },
		{ credentialEntry: "other/local/password" },
		{ enabled: "yes" },
		{ helperSHA256: "oops" },
		{ sourceSHA256: "" },
	])
		expect(() => autonomousProfile({ ...profile, ...patch })).toThrow("no legacy or ad-hoc fallback");
});

it("accepts linked legacy profiles while enforcing private files for autonomous signing", () => {
	const root = mkdtempSync(join(tmpdir(), "boa-signing-profile-test-"));
	try {
		const target = join(root, "profile.json");
		const link = join(root, "identity.json");
		writeFileSync(target, JSON.stringify({ identity: profile.identity }), { mode: 0o600 });
		symlinkSync(target, link);
		expect(readAutonomous(link)).toBeUndefined();
		writeFileSync(target, JSON.stringify(profile));
		expect(readAutonomous(target)).toEqual(profile);
		expect(() => readAutonomous(link)).toThrow("UNSAFE_LOCAL_SIGNING_FILE");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("requires a locked-screen proof bound to the unchanged configuration and helper", () => {
	const receipt = {
		version: 1,
		configHash: "config",
		identity: profile.identity,
		helperSHA256: profile.helperSHA256,
		screenLocked: true,
		twoDistinctBuilds: true,
		relocked: true,
	};
	expect(() => validateActivationReceipt(receipt, "config", profile)).not.toThrow();
	for (const patch of [
		{ configHash: "old" },
		{ identity: "D".repeat(40) },
		{ helperSHA256: "old" },
		{ screenLocked: false },
		{ twoDistinctBuilds: false },
		{ relocked: false },
	])
		expect(() => validateActivationReceipt({ ...receipt, ...patch }, "config", profile)).toThrow(
			"ACCEPTANCE_REQUIRED",
		);
});

it("waits for an actual locked signal and never treats an unavailable signal as success", async () => {
	await expect(waitForScreenLock(() => true, 10)).resolves.toBeUndefined();
	await expect(waitForScreenLock(() => null, 10)).rejects.toThrow("no signing was started");
});

it("refuses noninteractive provisioning before requesting any credential or touching the profile", () => {
	const result = spawnSync("bun", ["scripts/mac-signing.ts", "configure", "provision"], {
		encoding: "utf8",
		timeout: 2_000,
		stdio: ["ignore", "pipe", "pipe"],
	});
	expect(result.status).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("INTERACTIVE_TERMINAL_REQUIRED");
});

describe.skipIf(process.platform !== "darwin")("native helper without production credentials", () => {
	// A fresh runner needs to build the Swift SDK modules before compiling the helper.
	const compileTimeoutMs = 60_000;
	let root: string;
	let helper: string;
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "boa-signing-test-"));
		helper = join(root, "helper");
		execFileSync(
			"/usr/bin/xcrun",
			[
				"swiftc",
				"-D",
				"BOA_SIGNING_TESTS",
				"-suppress-warnings",
				"-module-cache-path",
				"work/autonomous-signing/module-cache",
				"scripts/mac-keychain.swift",
				"-o",
				helper,
			],
			{ timeout: compileTimeoutMs },
		);
	}, compileTimeoutMs + 1_000);
	afterAll(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("accepts the exact codesign ACL, refuses a passphrase requirement and stops a timed-out child", () => {
		const result = spawnSync(helper, ["self-test"], {
			encoding: "utf8",
			killSignal: "SIGKILL",
			timeout: 2_000,
		});
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			aclExactApp: true,
			passphraseRefused: true,
			childTimeoutEnforced: true,
			broadCredentialRefused: true,
		});
	});

	it("bounds a blocked native credential lookup before any vault is opened", () => {
		const result = spawnSync(helper, ["credential-timeout-test"], {
			encoding: "utf8",
			killSignal: "SIGKILL",
			timeout: 1_000,
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("CREDENTIAL_LOOKUP_TIMEOUT");
	});

	it("re-locks a disposable native vault when the operation fails", async () => {
		const vault = join(root, "failure.keychain-db");
		const setup = spawnSync(helper, ["vault-setup", vault], {
			encoding: "utf8",
			killSignal: "SIGKILL",
			timeout: 2_000,
		});
		expect(setup.status, setup.stderr).toBe(0);
		try {
			const failure = spawnSync(helper, ["vault-fail", vault], {
				encoding: "utf8",
				killSignal: "SIGKILL",
				timeout: 5_000,
			});
			expect(failure.status, failure.stderr).toBe(1);
			expect(failure.stderr).toContain("TEST_BODY_FAILED");
			await expect
				.poll(
					() => {
						const probe = spawnSync(helper, ["probe", vault], {
							encoding: "utf8",
							killSignal: "SIGKILL",
							timeout: 1_000,
						});
						return probe.status === 0 && JSON.parse(probe.stdout).dedicatedUnlocked === false;
					},
					{ timeout: 3_000, interval: 25 },
				)
				.toBe(true);
		} finally {
			const removed = spawnSync(helper, ["vault-remove", vault], {
				encoding: "utf8",
				killSignal: "SIGKILL",
				timeout: 2_000,
			});
			expect(removed.status, removed.stderr).toBe(0);
		}
	}, 10_000);

	it("recovers the native vault after its supervisor is killed", async () => {
		const vault = join(root, "recovery.keychain-db");
		const setup = spawnSync(helper, ["vault-setup", vault], {
			encoding: "utf8",
			killSignal: "SIGKILL",
			timeout: 2_000,
		});
		expect(setup.status, setup.stderr).toBe(0);
		const owner = spawn(helper, ["vault-hold", vault], { stdio: ["ignore", "pipe", "pipe"] });
		try {
			const child = await new Promise<{ childPID: number; childGroup: number; ownerGroup: number }>(
				(resolve, reject) => {
					let output = "";
					owner.stdout.on("data", (chunk) => {
						output += chunk.toString();
						const lines = output.split("\n");
						output = lines.pop() ?? "";
						for (const line of lines) {
							const record = JSON.parse(line);
							if (record.childPID) resolve(record);
						}
					});
					owner.once("error", reject);
					owner.once("exit", () => reject(new Error("Test owner exited before creating its child")));
				},
			);
			expect(child.childGroup).toBe(child.ownerGroup);
			const exited = once(owner, "exit");
			owner.kill("SIGKILL");
			await exited;
			await expect
				.poll(
					() => {
						const probe = spawnSync(helper, ["probe", vault], {
							encoding: "utf8",
							killSignal: "SIGKILL",
							timeout: 1_000,
						});
						return probe.status === 0 && JSON.parse(probe.stdout).dedicatedUnlocked === false;
					},
					{ timeout: 3_000, interval: 25 },
				)
				.toBe(true);
			await expect
				.poll(
					() => {
						try {
							process.kill(child.childPID, 0);
						} catch {
							return true;
						}
						const result = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(child.childPID)], {
							encoding: "utf8",
							timeout: 1_000,
						});
						return result.stdout.trim().startsWith("Z");
					},
					{ timeout: 3_000, interval: 25 },
				)
				.toBe(true);
			const lease = spawnSync(helper, ["lease-test", vault, "0"], {
				encoding: "utf8",
				killSignal: "SIGKILL",
				timeout: 1_000,
			});
			expect(lease.status, lease.stderr).toBe(0);
		} finally {
			if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
			const removed = spawnSync(helper, ["vault-remove", vault], {
				encoding: "utf8",
				killSignal: "SIGKILL",
				timeout: 2_000,
			});
			expect(removed.status, removed.stderr).toBe(0);
		}
	}, 10_000);

	it("serializes clients with a kernel lease and releases the lease after the owning process dies", async () => {
		const vault = join(root, "lease.keychain-db");
		writeFileSync(vault, "sentinel-not-a-keychain", { mode: 0o600 });
		const first = spawn(helper, ["lease-test", vault, "500"], { stdio: ["ignore", "pipe", "pipe"] });
		try {
			const [ready] = await once(first.stdout, "data");
			expect(JSON.parse(String(ready))).toEqual({ leased: true });
			const second = spawnSync(helper, ["lease-test", vault, "0"], {
				encoding: "utf8",
				killSignal: "SIGKILL",
				timeout: 1_000,
			});
			expect(second.status).toBe(1);
			expect(second.stderr).toContain("SIGNING_BUSY");
			const exited = once(first, "exit");
			first.kill("SIGKILL");
			await exited;
			const third = spawnSync(helper, ["lease-test", vault, "0"], {
				encoding: "utf8",
				killSignal: "SIGKILL",
				timeout: 1_000,
			});
			expect(third.status, third.stderr).toBe(0);
			expect(readFileSync(vault, "utf8")).toBe("sentinel-not-a-keychain");
		} finally {
			if (first.exitCode === null && first.signalCode === null) first.kill("SIGKILL");
		}
	}, 2_000);
});

it("enforces a hard transport deadline even if a child ignores SIGTERM", () => {
	const started = performance.now();
	expect(() => runSigningCommand("/bin/sh", ["-c", "trap '' TERM; while :; do :; done"], 100)).toThrow(
		"SIGNING_COMMAND_TIMEOUT_OR_START_FAILURE",
	);
	expect(performance.now() - started).toBeLessThan(600);
});

it.skipIf(process.platform !== "darwin")(
	"restores terminal settings after killing the prompt",
	() => {
		const fixture = `
		import { execFileSync } from "node:child_process";
		import { runSigningCommand } from "./scripts/mac-signing-session.ts";
		const state = () => execFileSync("/bin/stty", ["-f", "/dev/tty", "-g"], { encoding: "utf8" });
		const before = state();
		try {
			runSigningCommand("/bin/sh", ["-c", "/bin/stty -f /dev/tty -echo && echo prompt-ready && exec /bin/sleep 30"], 300, true);
		} catch (error) {
			if (error.message === "SIGNING_COMMAND_TIMEOUT_OR_START_FAILURE" && state() === before)
				console.log("terminal-restored");
		}
	`;
		const result = spawnSync("/usr/bin/script", ["-q", "/dev/null", "bun", "-e", fixture], {
			encoding: "utf8",
			timeout: 1_800,
			stdio: ["ignore", "pipe", "pipe"],
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("prompt-ready");
		expect(result.stdout).toContain("terminal-restored");
	},
	2_000,
);
