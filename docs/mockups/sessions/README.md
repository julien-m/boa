# Session cockpit mockups

Visual references for the coding-session cockpit. All projects, sessions, branches and
code shown are fictional demo data ("Données de démo"); no personal workspace data.

| File | Screen | Source version |
| --- | --- | --- |
| `05-sessions-overview.png` | Global Sessions view grouped by project | v4 |
| `06-project-dock.png` | Project view with the application-level session dock and branch picker | v5 |
| `07-send-context.png` | Context composer sending to a session | v5 |
| `08-session-actions-settings.png` | Session actions settings (global and project overrides) | v5 |
| `09-persistent-session.png` | Session dock persisting while another project is displayed | v4 |
| `10-dock-sessions-conversation.png` | Dock with closable session tabs and a readable conversation | Claude Design, pending visual approval |
| `10-dock-sessions-conversation-v2.png` | Compact session tabs and sortable session columns | Claude Design, revised for visual approval |

Behavioral contract that overrides older mockups: the primary button is always **Send**.
BOA transmits immediately; the provider's own queue/steer mode decides how a message
reaches a running session. BOA has no local send queue.
