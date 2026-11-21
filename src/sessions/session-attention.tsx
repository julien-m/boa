/**
 * Title-bar signal for Claude permission prompts that the dock is not showing, so a session
 * waiting for a decision can always be found. Only the session title is shown, never the prompt.
 */
import { ShieldAlert } from "lucide-react";
import { useSessionDock } from "./session-dock-state";
import { useSessionText } from "./session-labels";

export function SessionAttention() {
	const { t } = useSessionText();
	const dock = useSessionDock();
	const visible = dock.open && !dock.collapsed && !dock.detached && dock.current?.provider === "claude";
	const hidden = dock.permissions.filter((request) => !(visible && request.sessionId === dock.current?.id));
	const first = hidden[0];
	if (!first) return null;
	return (
		<button
			type="button"
			className="quiet-button session-attention"
			data-testid="session-attention"
			onClick={() => dock.show({ provider: "claude", id: first.sessionId })}
		>
			<ShieldAlert size={13} aria-hidden="true" />
			{t("permissions.waiting", { count: hidden.length })}
		</button>
	);
}
