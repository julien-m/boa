import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { compatibleUpdate, identityFromProfile, installBundle, requirement } from "./mac-signing";

const fingerprint = "A".repeat(40);
const available = `  1) ${fingerprint} "Example Signing Identity"\n     1 valid identities found`;
it("resolves an exact configured certificate without an ad-hoc fallback", () => {
	expect(identityFromProfile({ identity: fingerprint.toLowerCase() }, available)).toBe(fingerprint);
	for (const identity of ["-", "Example Signing Identity", "", `${fingerprint}; echo unsafe`])
		expect(() => identityFromProfile({ identity }, available)).toThrow("exact certificate");
});
it("refuses missing or expired identities instead of silently changing signer", () => {
	expect(() => identityFromProfile({ identity: "B".repeat(40) }, available)).toThrow(
		"unavailable or expired",
	);
	expect(() => identityFromProfile({ identity: fingerprint }, "0 valid identities found")).toThrow(
		"no ad-hoc fallback",
	);
	expect(() => identityFromProfile(null, available)).toThrow("exact certificate");
});

it.skipIf(process.platform !== "darwin")("reads native codesign requirements from stdout", () => {
	expect(requirement("/usr/bin/true")).toMatch(/identifier|anchor/);
});

// Opt-in acceptance check: use a real existing identity, never create/export a private key.
it.skipIf(process.platform !== "darwin" || !process.env.BOA_TEST_SIGNING_IDENTITY)(
	"retains mutual requirements across two different installed builds",
	() => {
		const root = mkdtempSync(join(tmpdir(), "boa-signing-test-"));
		try {
			const fixture = (version: number) => {
				const bundle = join(root, String(version), "BOA.app");
				mkdirSync(join(bundle, "Contents/MacOS"), { recursive: true });
				writeFileSync(
					join(bundle, "Contents/Info.plist"),
					`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.julienm.boa</string><key>CFBundleExecutable</key><string>boa</string><key>CFBundleVersion</key><string>${version}</string></dict></plist>`,
				);
				const source = join(root, `probe-${version}.c`);
				writeFileSync(source, `int main(void) { return ${version}; }\n`);
				execFileSync("xcrun", ["clang", source, "-o", join(bundle, "Contents/MacOS/boa")], {
					timeout: 10_000,
				});
				execFileSync("codesign", ["--force", "--sign", "-", bundle], { timeout: 10_000 });
				return bundle;
			};
			const one = fixture(1);
			const two = fixture(2);
			const identity = process.env.BOA_TEST_SIGNING_IDENTITY as string;
			const destination = join(root, "installed/BOA.app");
			const first = installBundle(one, destination, identity);
			expect(first).not.toContain("cdhash");
			expect(compatibleUpdate(one, destination)).toBe(false);
			const details = () =>
				spawnSync("codesign", ["-dv", "--verbose=4", destination], { encoding: "utf8", timeout: 10_000 })
					.stderr;
			const firstHash = details().match(/^CDHash=(.+)$/m)?.[1];
			const second = installBundle(two, destination, identity);
			expect(second).toBe(first);
			expect(requirement(destination)).toBe(first);
			expect(details().match(/^CDHash=(.+)$/m)?.[1]).not.toBe(firstHash);
			execFileSync("codesign", ["--verify", "--deep", "--strict", `-R=${first}`, destination], {
				timeout: 10_000,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
	30_000,
);
