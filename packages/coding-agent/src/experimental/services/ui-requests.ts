import { type Context, defineService, type JsonValue, type ReplicatedState } from "@earendil-works/chord";

export type UiRequestKind = "select" | "confirm" | "input";

export interface UiRequestItem {
	value: string;
	label: string;
	description: string | null;
}

/** A question an extension asked the person, waiting for an answer from a presentation. */
export interface UiRequest {
	/** Stable for the life of the request; a presentation answers or cancels by this ID. */
	id: string;
	kind: UiRequestKind;
	title: string;
	message: string | null;
	/** The choices of a `select`. */
	items: UiRequestItem[] | null;
	placeholder: string | null;
	defaultValue: string | null;
	/** Epoch milliseconds. */
	createdAt: number;
	/** Epoch milliseconds after which the request is cancelled; null waits indefinitely. */
	deadline: number | null;
}

export interface UiNotice {
	id: string;
	level: "info" | "warning" | "error";
	message: string;
	at: number;
}

export interface UiRequestsState {
	requests: UiRequest[];
	/** Status lines extensions keep up to date, by key. */
	status: Record<string, string>;
	/** The most recent notices, oldest first. */
	notices: UiNotice[];
}

export interface UiRespondResult {
	accepted: boolean;
	/** Why an answer was not accepted (the request stays pending). */
	reason: string | null;
}

/**
 * What a presentation can see and do about extension interactions: the pending questions, status lines
 * and notices as replicated state, and a way to answer or withdraw each question.
 */
export interface UiRequests {
	readonly state: ReplicatedState<UiRequestsState>;
	/** Answer a pending request: a string for `select` (one of its items) and `input`, a boolean for `confirm`. */
	respond(id: string, value: JsonValue, context: Context): Promise<UiRespondResult>;
	cancel(id: string, context: Context): Promise<{ cancelled: boolean }>;
}

export const UiRequests = defineService<UiRequests>("pi.ui-requests");

export interface UiAskOptions {
	message?: string;
	/** Give up after this many milliseconds; the default is two minutes, 0 waits indefinitely. */
	timeoutMs?: number;
}

/**
 * What session-side facets use to interact with the person, whichever presentation is attached. An
 * unanswered question resolves `undefined` once it times out, is cancelled, or the Session shuts down, so
 * an extension never waits forever on a presentation that cannot ask.
 */
export interface UiRequestHost {
	select(
		title: string,
		items: readonly { value: string; label: string; description?: string }[],
		options: UiAskOptions | undefined,
		context: Context,
	): Promise<string | undefined>;
	confirm(title: string, options: UiAskOptions | undefined, context: Context): Promise<boolean | undefined>;
	input(
		title: string,
		options: (UiAskOptions & { placeholder?: string; defaultValue?: string }) | undefined,
		context: Context,
	): Promise<string | undefined>;
	notify(level: UiNotice["level"], message: string): void;
	/** Set a status line, or clear it with null. */
	setStatus(key: string, text: string | null): void;
}

export const UiRequestHost = defineService<UiRequestHost>("pi.local.ui-request-host", { local: true });

export const UI_DEFAULT_TIMEOUT_MS = 120_000;
export const UI_MAX_PENDING = 20;
export const UI_MAX_NOTICES = 20;
export const UI_MAX_INPUT_CHARS = 10_000;
export const UI_MAX_TITLE_CHARS = 300;
