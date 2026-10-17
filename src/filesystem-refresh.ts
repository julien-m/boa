import { type Query, type QueryClient, queryOptions } from "@tanstack/react-query";
import { api } from "./api";

/** Archived projects are not watched; returning observers must read current state. */
export function projectSummaryOptions(project: string) {
	return queryOptions({
		queryKey: ["summary", project],
		// Consume the signal so archive/remount cannot join an obsolete initial request.
		queryFn: ({ signal }) => api.summary(project, signal),
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnMount: "always",
		retry: false,
	});
}

/** Serialize each event-driven query group and preserve a trailing refresh. */
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
	async function flush(group: string, predicate: (query: Query) => boolean) {
		running.add(group);
		try {
			while (!disposed && dirty.delete(group)) {
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
				dirty.delete(group);
				await client.invalidateQueries({ predicate }, { cancelRefetch: false });
			}
		} finally {
			running.delete(group);
		}
	}
	function enqueue(group: string, predicate: (query: Query) => boolean) {
		if (disposed) return;
		dirty.add(group);
		if (!running.has(group)) void flush(group, predicate);
	}
	return {
		project(project: string) {
			enqueue(`project:${project}`, (query) => matches(query, project));
		},
		collection(name: "projects" | "settings") {
			enqueue(`collection:${name}`, (query) => query.queryKey[0] === name);
		},
		dispose() {
			disposed = true;
			dirty.clear();
		},
	};
}
