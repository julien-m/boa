/** Find the same visible passage after insertions/deletions, using nearby text as a fallback. */
export function relocateLine(before: string, after: string, line: number): number {
	const previous = before.split(/\r?\n/);
	const next = after.split(/\r?\n/);
	const start = Math.max(0, Math.min(previous.length - 1, line - 1));
	for (let radius = 0; radius <= 12; radius++) {
		for (const oldIndex of radius ? [start + radius, start - radius] : [start]) {
			if (!previous[oldIndex]?.trim()) continue;
			let match = -1;
			let best = -Infinity;
			for (let index = 0; index < next.length; index++) {
				if (next[index] !== previous[oldIndex]) continue;
				let score = -Math.abs(index - oldIndex) / Math.max(next.length, previous.length);
				for (const offset of [-2, -1, 1, 2]) {
					if (
						previous[oldIndex + offset] !== undefined &&
						next[index + offset] === previous[oldIndex + offset]
					)
						score += 1;
				}
				if (score > best) {
					best = score;
					match = index;
				}
			}
			if (match >= 0) return Math.max(1, Math.min(next.length, match + 1));
		}
	}
	return Math.min(next.length, start + 1);
}
