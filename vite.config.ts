import process from "node:process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;
// Monaco 0.57 imports a bundled DOMPurify 3.4.15 copy via a relative path.
const domPurifyAlias = { "./dompurify/dompurify.js": "dompurify" };

// https://vite.dev/config/
export default defineConfig(() => ({
	plugins: [react()],
	resolve: { alias: domPurifyAlias },
	optimizeDeps: {
		// The dev pre-bundler has its own resolver for imports inside dependencies.
		rolldownOptions: { resolve: { alias: domPurifyAlias } },
	},

	// Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
	//
	// 1. prevent Vite from obscuring rust errors
	clearScreen: false,
	// 2. tauri expects a fixed port, fail if that port is not available
	server: {
		port: 1420,
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: "ws",
					host,
					port: 1421,
				}
			: undefined,
		watch: {
			// 3. tell Vite to ignore watching `src-tauri`
			ignored: ["**/src-tauri/**"],
		},
	},
}));
