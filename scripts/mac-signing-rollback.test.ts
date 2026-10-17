import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ destination: "", reads: 0, trashed: [] as string[] }));
vi.mock("node:child_process", () => ({
	execFileSync(command: string, args: string[]) {
		if (command.endsWith("PlistBuddy")) return args[1].includes("Identifier") ? "com.julienm.boa\n" : "boa\n";
		if (command.endsWith("ditto")) cpSync(args[0], args[1], { recursive: true });
		if (command.endsWith("trash")) {
			fault.trashed.push(args[0]);
			if (args[0] === fault.destination) throw new Error("trash failed during rollback");
		}
		return "";
	},
	spawnSync(command: string, args: string[]) {
		if (command.endsWith("pgrep")) return { status: 1 };
		if (args.at(-1) === fault.destination && ++fault.reads === 2)
			return { status: 1, stdout: "", stderr: "final requirement read failed" };
		return {
			status: 0,
			stdout: 'designated => identifier "com.julienm.boa" and anchor apple generic\n',
			stderr: "",
		};
	},
}));

import { installBundle } from "./mac-signing";

it("retains and reports the old bundle if final verification and rollback both fail", () => {
	const root = mkdtempSync(join(tmpdir(), "boa-rollback-test-"));
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const source = join(root, "source/BOA.app");
		const destination = join(root, "installed/BOA.app");
		for (const path of [source, destination]) mkdirSync(path, { recursive: true });
		writeFileSync(join(source, "marker"), "new");
		writeFileSync(join(destination, "marker"), "previous");
		fault.destination = destination;
		fault.reads = 0;
		fault.trashed.length = 0;
		expect(() => installBundle(source, destination, "A".repeat(40))).toThrow("trash failed during rollback");
		const workspace = join(
			dirname(destination),
			readdirSync(dirname(destination)).find((path) => path.startsWith(".boa-install-")) as string,
		);
		const backup = join(workspace, "previous.app");
		expect(existsSync(backup)).toBe(true);
		expect(readFileSync(join(backup, "marker"), "utf8")).toBe("previous");
		expect(fault.trashed).toEqual([destination]);
		expect(error).toHaveBeenCalledWith(`Previous application retained for recovery: ${backup}`);
	} finally {
		error.mockRestore();
		rmSync(root, { recursive: true, force: true });
	}
});
