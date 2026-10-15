/** Catch accidental local data in the source set before public commits. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
	encoding: "utf8",
})
	.split("\0")
	.filter(Boolean);
const patterns = [
	/\/Users\/(?!example(?:\/|\b))[^/\s]+\//,
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
	/\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
	/\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
	/\bsk-(?:ant-)?[A-Za-z0-9_-]{30,}\b/,
	/https?:\/\/[^/\s:@]+:[^/\s@]+@/,
];
const findings: string[] = [];
for (const file of new Set(files)) {
	if (/(^|\/)(?:projects\.json|\.env(?:\..*)?|\.dev\.vars|outputs|target|node_modules)(?:\/|$)/.test(file)) {
		findings.push(`${file}: local configuration or generated data`);
		continue;
	}
	const bytes = readFileSync(file);
	if (bytes.includes(0)) continue;
	const content = bytes.toString("utf8");
	if (patterns.some((pattern) => pattern.test(content)))
		findings.push(`${file}: potential private path or credential`);
}
if (findings.length) {
	console.error(findings.join("\n"));
	process.exit(1);
}
console.log(
	`PASS: ${new Set(files).size} source files checked for local data and common credential patterns.`,
);
