import { type Context, defineFacet, type Facet, type JsonValue } from "@earendil-works/chord";
import type { Conversation, EntryId } from "@earendil-works/pi-durable";
import { HISTORY_MAX_PAGE, History, type HistoryPage, type HistoryPageRequest } from "./history.ts";

/** Page through a conversation's durable entries, newest first. */
export function createHistory(conversation: Conversation): History {
	return {
		async page(request: HistoryPageRequest, context: Context): Promise<HistoryPage> {
			const limit = Math.min(Math.max(Math.trunc(Number(request.limit)) || 1, 1), HISTORY_MAX_PAGE);
			const before = request.before;
			if (before !== null && (!Number.isSafeInteger(before) || before < 1)) {
				throw new Error("history.page: before must be a positive entry id or null");
			}
			// No entry has an ID below 1, so asking for entries before 1 is an empty, finished page.
			if (before === 1) return { entries: [], more: false };
			const page = await conversation.entries(
				before === null ? {} : { maxEntryId: (before - 1) as EntryId },
				limit,
				undefined,
				context,
			);
			return { entries: page.items as unknown as JsonValue[], more: page.next !== undefined };
		},
	};
}

/** Serve `History` from the session worker's root conversation. */
export function createHistoryServiceFacet(conversation: Conversation): Facet {
	return defineFacet({
		id: "@pi/history",
		setup(env) {
			env.provide(History, createHistory(conversation));
		},
	});
}
