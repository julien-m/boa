import { describe, expect, it } from "vitest";
import { type StreamEvent, TerminalStream } from "./terminal-stream";

const bytes = (text: string) => new TextEncoder().encode(text);
const output = (offset: number, text: string, terminalId = "t1"): StreamEvent => ({
	event: "output",
	terminalId,
	offset,
	data: bytes(text),
});

function collect() {
	const chunks: Uint8Array[] = [];
	const stream = new TerminalStream((chunk) => chunks.push(chunk.slice()));
	const text = () => new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk])));
	return { stream, text };
}

describe("terminal stream reconciliation", () => {
	it("buffers events racing the open request and writes each byte exactly once", () => {
		const { stream, text } = collect();
		// Emitted before the snapshot (already inside it), straddling it, and after it.
		stream.push(output(0, "hello "));
		stream.push(output(6, "wor"));
		stream.push(output(9, "ld!"));
		stream.push(output(12, " more", "other-terminal"));
		stream.attach("t1", bytes("hello wo"), 8, true);
		stream.push(output(12, " next"));
		stream.push(output(9, "ld!"));
		expect(text()).toBe("hello world! next");
	});

	it("keeps an exit that happened while opening", () => {
		const { stream, text } = collect();
		stream.push(output(0, "bye"));
		stream.push({ event: "exit", terminalId: "t1", end: 3 });
		stream.attach("t1", bytes(""), 0, true);
		expect(text()).toBe("bye");
		expect(stream.exited).toBe(true);
	});
});
