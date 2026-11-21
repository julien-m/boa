/**
 * Reconciles a terminal snapshot with streamed output by byte offset: events received while
 * the open request is in flight are buffered (bounded), then only bytes after the snapshot
 * are written, so nothing is lost or duplicated on first attach or re-attach.
 */
export type OutputEvent = { event: "output"; terminalId: string; offset: number; data: Uint8Array };
export type ExitEvent = { event: "exit"; terminalId: string; end: number };
export type StreamEvent = OutputEvent | ExitEvent;

/** Events buffered before the snapshot arrives; beyond this the snapshot still covers the screen. */
const MAX_PENDING_BYTES = 1024 * 1024;

export class TerminalStream {
	private pending: StreamEvent[] = [];
	private pendingBytes = 0;
	private written: number | null = null;
	private terminalId: string | null = null;
	exited = false;

	constructor(private readonly write: (bytes: Uint8Array) => void) {}

	/** Accepts an event; before `attach` it is buffered, afterwards applied in order. */
	push(event: StreamEvent): void {
		if (this.terminalId === null) {
			this.pending.push(event);
			if (event.event === "output") this.pendingBytes += event.data.length;
			// Drop the oldest buffered output first: the snapshot will contain recent history anyway.
			while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length > 1) {
				const dropped = this.pending.shift();
				if (dropped?.event === "output") this.pendingBytes -= dropped.data.length;
			}
			return;
		}
		if (event.terminalId === this.terminalId) this.apply(event);
	}

	/** Writes the snapshot, then buffered events of this terminal past its end. */
	attach(terminalId: string, snapshot: Uint8Array, snapshotEnd: number, running: boolean): void {
		this.terminalId = terminalId;
		this.written = snapshotEnd;
		this.exited = !running;
		this.write(snapshot);
		const buffered = this.pending.filter((event) => event.terminalId === terminalId);
		this.pending = [];
		this.pendingBytes = 0;
		for (const event of buffered) this.apply(event);
	}

	private apply(event: StreamEvent): void {
		if (event.event === "exit") {
			this.exited = true;
			return;
		}
		const written = this.written ?? 0;
		const end = event.offset + event.data.length;
		if (end <= written) return;
		const skip = Math.max(0, written - event.offset);
		this.write(event.data.subarray(skip));
		this.written = end;
	}
}
