/**
 * Popup menu on the native Popover API (light dismiss, Escape, top layer).
 * WebKit lacks focusgroup and CSS anchor positioning, so roles, arrow keys and placement
 * follow the documented script fallbacks.
 */
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useId, useRef } from "react";

/** Below the trigger, aligned to its end, flipped above and clamped when it would overflow. */
function place(menu: HTMLElement, trigger: HTMLElement): void {
	const anchor = trigger.getBoundingClientRect();
	const box = menu.getBoundingClientRect();
	const gap = 4;
	const below = anchor.bottom + gap + box.height <= window.innerHeight;
	const top = below ? anchor.bottom + gap : Math.max(gap, anchor.top - gap - box.height);
	const left = Math.min(Math.max(gap, anchor.right - box.width), window.innerWidth - box.width - gap);
	menu.style.top = `${top}px`;
	menu.style.left = `${left}px`;
}

function items(menu: HTMLElement): HTMLElement[] {
	return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
}

export function PopoverMenu({
	label,
	trigger,
	triggerClassName = "icon-button",
	children,
}: {
	label: string;
	trigger: ReactNode;
	triggerClassName?: string;
	children: (close: () => void) => ReactNode;
}) {
	const id = useId();
	const menuRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const fromKeyboard = useRef(false);

	const close = () => {
		triggerRef.current?.focus({ focusVisible: false } as FocusOptions);
		menuRef.current?.hidePopover();
	};

	const onToggle = (event: React.ToggleEvent<HTMLDivElement>) => {
		const menu = menuRef.current;
		const button = triggerRef.current;
		if (!menu || !button) return;
		const open = event.newState === "open";
		button.setAttribute("aria-expanded", String(open));
		if (!open) return;
		place(menu, button);
		if (fromKeyboard.current) items(menu)[0]?.focus();
		fromKeyboard.current = false;
	};

	const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		const menu = menuRef.current;
		if (!menu || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		const list = items(menu);
		const current = list.indexOf(document.activeElement as HTMLElement);
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? list.length - 1
					: (current + (event.key === "ArrowUp" ? -1 : 1) + list.length) % list.length;
		event.preventDefault();
		list[next]?.focus();
	};

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				className={triggerClassName}
				aria-label={label}
				data-hint={label}
				aria-haspopup="menu"
				aria-expanded="false"
				{...({ commandfor: id, command: "toggle-popover" } as Record<string, string>)}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown") {
						event.preventDefault();
						fromKeyboard.current = true;
						menuRef.current?.showPopover();
					}
				}}
				onClick={(event) => {
					// detail 0: keyboard activation (Enter/Space) enters the menu.
					fromKeyboard.current = event.detail === 0;
				}}
			>
				{trigger}
			</button>
			<div
				ref={menuRef}
				id={id}
				popover="auto"
				role="menu"
				aria-label={label}
				className="popover-menu"
				onToggle={onToggle}
				onKeyDown={onMenuKeyDown}
			>
				{children(close)}
			</div>
		</>
	);
}

/** One command in a `PopoverMenu`; closes the menu after running. */
export function MenuItem({
	children,
	onSelect,
	close,
	disabled,
	hint,
}: {
	children: ReactNode;
	onSelect: () => void;
	close: () => void;
	disabled?: boolean;
	hint?: string;
}) {
	return (
		<button
			type="button"
			role="menuitem"
			disabled={disabled}
			title={hint}
			onPointerMove={(event) => event.currentTarget.focus({ focusVisible: false } as FocusOptions)}
			onClick={() => {
				close();
				onSelect();
			}}
		>
			{children}
		</button>
	);
}
