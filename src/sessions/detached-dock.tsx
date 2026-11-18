/** Root of the explicitly detached dock window: the same dock, no second transport owner. */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { SessionDock } from "./session-dock";
import "../workspace.css";
import "./sessions.css";

export function DetachedDock() {
	const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
	return (
		<div className="detached-dock">
			<SessionDock
				detachedWindow
				projects={(projects.data ?? []).map((project) => ({ path: project.path, name: project.name }))}
			/>
		</div>
	);
}
