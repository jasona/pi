import { type Context, defineService, type JsonValue } from "@earendil-works/chord";

/** What the caller asks for: the page of entries just older than `before`. */
export interface HistoryPageRequest {
	/** Return entries with an ID below this one; null starts at the newest entry. */
	before: number | null;
	/** How many entries at most; the service bounds it. */
	limit: number;
}

/** A page of the conversation's durable entries, newest first. */
export interface HistoryPage {
	/** Raw entry records, as `ConversationView.entries` carries them. */
	entries: JsonValue[];
	/** Older entries remain beyond this page. */
	more: boolean;
}

/**
 * The conversation's whole fork-aware history. `Transcript` serves only the active context (since the
 * newest reset or compaction); this pages through everything before it.
 */
export interface History {
	page(request: HistoryPageRequest, context: Context): Promise<HistoryPage>;
}

export const History = defineService<History>("pi.history");

/** Most entries one page may carry. */
export const HISTORY_MAX_PAGE = 200;
