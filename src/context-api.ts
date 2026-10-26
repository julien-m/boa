/** Local, app-owned persistent guided reading and display receipts. */
import { invoke } from "@tauri-apps/api/core";

export interface ContextPassage {
	id: string;
	path: string;
	startLine: number;
	endLine: number;
	label?: string;
	role?: string;
	symbol?: string;
	text?: string;
}
export interface ContextStep {
	id: string;
	title: string;
	description: string;
	group?: string;
	passages: ContextPassage[];
}
export interface ContextView {
	id: string;
	project: string;
	title: string;
	description: string;
	kind: "walkthrough" | "findings";
	steps: ContextStep[];
	revision: number;
	updatedAt: number;
}
export type ContextViewInput = Omit<ContextView, "revision" | "updatedAt"> &
	Partial<Pick<ContextView, "revision" | "updatedAt">>;
export interface ReaderOpenRequest {
	requestId: string;
	file: string;
	line: number;
	endLine: number;
	source: string;
	context?: { project: string; viewId: string; stepId: string; passageId: string };
}
export type ReaderStatus = "pending" | "displayed" | "paused" | "missing" | "needs-review" | "failed";
export interface ReaderReceipt {
	requestId: string;
	status: ReaderStatus;
	message?: string;
	request: ReaderOpenRequest;
}
const request = <T>(value: Record<string, unknown>): Promise<T> =>
	invoke("context_views", { request: value });
export const contextApi = {
	list: (project: string): Promise<ContextView[]> => request({ action: "list", project }),
	get: (project: string, id: string): Promise<ContextView> => request({ action: "get", project, id }),
	save: (view: ContextViewInput, expectedRevision?: number): Promise<ContextView> =>
		request({ action: "save", view, expectedRevision }),
	remove: (project: string, id: string): Promise<void> => request({ action: "remove", project, id }),
	open: (project: string, id: string, stepId?: string, passageId?: string): Promise<ReaderReceipt> =>
		request({ action: "open", project, id, stepId, passageId }),
	pending: (): Promise<ReaderOpenRequest[]> => invoke("reader_pending"),
	status: (requestId: string): Promise<ReaderReceipt> => invoke("reader_status", { requestId }),
	acknowledge: (
		requestId: string,
		status: Exclude<ReaderStatus, "pending">,
		message?: string,
	): Promise<ReaderReceipt> => invoke("reader_acknowledge", { requestId, status, message }),
};
