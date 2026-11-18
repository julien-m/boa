import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./boa-app";
import { ContextCollectionProvider } from "./context-collection";
import { ControlHints } from "./control-hints";
import { FileEditingProvider } from "./file-editing";
import { DetachedDock } from "./sessions/detached-dock";
import { SessionDockProvider } from "./sessions/session-dock-state";
import { WindowCloseGuard } from "./window-close";

const client = new QueryClient({
	defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

/** The explicitly detached session dock reuses this bundle with its own minimal root. */
const detached = new URLSearchParams(window.location.search).get("window") === "session-dock";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<QueryClientProvider client={client}>
			<SessionDockProvider>
				{detached ? (
					<DetachedDock />
				) : (
					<FileEditingProvider>
						<ContextCollectionProvider>
							<App />
							<ControlHints />
							<WindowCloseGuard />
						</ContextCollectionProvider>
					</FileEditingProvider>
				)}
			</SessionDockProvider>
		</QueryClientProvider>
	</React.StrictMode>,
);
