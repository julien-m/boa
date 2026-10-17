import type { Query, QueryClient } from "@tanstack/react-query";

/** Keep one scan per project in flight, plus one trailing refresh for newer writes. */
export function createFilesystemRefresh(client: QueryClient) {
	const dirty = new Set<string>();
	const running = new Set<string>();
	let disposed = false;
	const matches = (query: Query, project: string): boolean => {
		const key = query.queryKey;
		return (
			key.includes(project) ||
			(key[0] === "preview" &&
				typeof key[1] === "object" &&
				key[1] !== null &&
				"project" in key[1] &&
				key[1].project === project)
		);
	};
	async function flush(project: string) {
		running.add(project);
		try {
			while (!disposed && dirty.delete(project)) {
				const predicate = (query: Query) => matches(query, project);
				// Wait even for inactive queries: invalidation only refetches active ones.
				await Promise.allSettled(
					client
						.getQueryCache()
						.findAll({ predicate })
						.filter((query) => query.state.fetchStatus === "fetching")
						.map((query) => query.promise),
				);
				if (disposed) break;
				// Writes received while waiting are covered by the scan starting now.
				dirty.delete(project);
				await client.invalidateQueries({ predicate }, { cancelRefetch: false });
			}
		} finally {
			running.delete(project);
		}
	}
	return {
		project(project: string) {
			if (disposed) return;
			dirty.add(project);
			if (!running.has(project)) void flush(project);
		},
		dispose() {
			disposed = true;
			dirty.clear();
		},
	};
}
