/** Workspace-local guided reading never replaces the reader's return position on step changes. */
import { useEffect, useRef, useState } from "react";
import { captureReaderSelection } from "./code-viewer";
import { currentContextStep } from "./context-anchors";
import { type ContextPassage, type ContextStep, type ContextView, contextApi } from "./context-api";
import { useContextViews } from "./context-views";
import type { Selection } from "./models";
import { rememberReadingReturn, takeReadingReturn } from "./reading-return";

export function useGuidedReading({
	project,
	selection,
	navigation,
	onRestore,
}: {
	project: string;
	selection: Selection | null;
	navigation: Selection | null;
	onRestore: (selection: Selection, keep: boolean) => void;
}) {
	const [contextPanel, setContextPanel] = useState(false);
	const [preparedViewId, setPreparedViewId] = useState<string>();
	const [error, setError] = useState<string | null>(null);
	const current = useRef(selection);
	current.current = selection;
	const restore = useRef(onRestore);
	restore.current = onRestore;
	const { views } = useContextViews(project);
	const reference = selection?.contextRef;
	const active = reference?.project === project ? reference : null;
	const view = views.find((item) => item.id === active?.viewId) ?? null;
	const step = currentContextStep(view, active?.stepId);
	useEffect(() => {
		if (active) setContextPanel(true);
	}, [active?.project, active?.viewId, active?.stepId]);
	const remember = () => {
		const original = current.current;
		if (original && !original.contextRef) {
			const { receiptId: _receiptId, ...snapshot } = captureReaderSelection(original);
			if (rememberReadingReturn(snapshot)) restore.current(snapshot, true);
		}
	};
	const rememberRef = useRef(remember);
	rememberRef.current = remember;
	useEffect(() => {
		if (!navigation?.contextRef) return;
		rememberRef.current();
		setContextPanel(true);
		setError(null);
	}, [navigation]);
	useEffect(() => {
		const listener = (event: Event) => {
			const detail = (event as CustomEvent<{ project: string; viewId: string }>).detail;
			if (detail?.project !== project) return;
			setContextPanel(true);
			setPreparedViewId(detail.viewId);
		};
		window.addEventListener("boa:bookmark-saved", listener);
		return () => window.removeEventListener("boa:bookmark-saved", listener);
	}, [project]);
	const open = (nextView: ContextView, nextStep: ContextStep, passage: ContextPassage) => {
		rememberRef.current();
		setError(null);
		void contextApi.open(nextView.project, nextView.id, nextStep.id, passage.id).catch((error) => {
			setError(String(error));
		});
	};
	const index = view?.steps.findIndex((item) => item.id === step?.id) ?? -1;
	const neighbor = (offset: number) => {
		if (index < 0) return undefined;
		const next = view?.steps[index + offset];
		return view && next?.passages[0] ? () => open(view, next, next.passages[0]) : undefined;
	};
	return {
		contextPanel,
		setContextPanel,
		preparedViewId,
		active,
		view,
		step,
		error,
		open,
		previous: neighbor(-1),
		next: neighbor(1),
		returnToReading: () => {
			const original = takeReadingReturn();
			setError(null);
			if (original) {
				if (original.project === project)
					restore.current({ ...original, navigationId: crypto.randomUUID() }, true);
				else window.dispatchEvent(new CustomEvent("boa:restore-reading", { detail: original }));
			} else if (current.current) {
				const { contextRef: _contextRef, receiptId: _receiptId, ...value } = current.current;
				restore.current({ ...value, navigationId: crypto.randomUUID() }, true);
			}
		},
	};
}
