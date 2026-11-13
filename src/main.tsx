import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./boa-app";
import { ContextCollectionProvider } from "./context-collection";
import { ControlHints } from "./control-hints";
import { FileEditingProvider } from "./file-editing";
import { WindowCloseGuard } from "./window-close";

const client = new QueryClient({
	defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<QueryClientProvider client={client}>
			<FileEditingProvider>
				<ContextCollectionProvider>
					<App />
					<ControlHints />
					<WindowCloseGuard />
				</ContextCollectionProvider>
			</FileEditingProvider>
		</QueryClientProvider>
	</React.StrictMode>,
);
