import { createFacetHost, defineFacet, type JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { createAgentController } from "../src/experimental/services/agent-controller-provider.ts";
import { HISTORY_MAX_PAGE, History } from "../src/experimental/services/history.ts";
import { createHistory } from "../src/experimental/services/history-provider.ts";
import { openFauxConversation } from "./experimental-durable-support.ts";

type Entry = { id: number; kind?: string; model?: { role: string; content: unknown }[] };

function userTexts(entries: Entry[]): string[] {
	return entries.flatMap((entry) =>
		(entry.model ?? []).flatMap((m) => (m.role === "user" && typeof m.content === "string" ? [m.content] : [])),
	);
}

describe("History service", () => {
	test("pages the whole history, newest first, past a reset that the transcript view hides", async () => {
		const { harness, conversation, close } = await openFauxConversation([
			fauxAssistantMessage("answer one"),
			fauxAssistantMessage("answer two"),
			fauxAssistantMessage("answer three"),
		]);
		const controller = createAgentController(harness, conversation);
		const history = createHistory(conversation);
		try {
			for (const message of ["question one", "question two"]) {
				const sent = await controller.prompt({ message, images: null }, BACKGROUND_CONTEXT);
				if (!sent.accepted) throw new Error("rejected");
				await controller.waitForPrompt(sent.operationId, BACKGROUND_CONTEXT);
			}
			await conversation.reset(undefined, BACKGROUND_CONTEXT);
			const sent = await controller.prompt({ message: "question three", images: null }, BACKGROUND_CONTEXT);
			if (!sent.accepted) throw new Error("rejected");
			await controller.waitForPrompt(sent.operationId, BACKGROUND_CONTEXT);

			// The transcript view holds only the new context.
			const view = await conversation.viewState(BACKGROUND_CONTEXT);
			let active: Entry[];
			try {
				active = view.value.entries as unknown as Entry[];
			} finally {
				view.dispose();
			}
			expect(userTexts(active)).toEqual(["question three"]);

			// History holds everything, newest first.
			const all = await history.page({ before: null, limit: 100 }, BACKGROUND_CONTEXT);
			expect(all.more).toBe(false);
			const entries = all.entries as unknown as Entry[];
			expect(entries.map((e) => e.id)).toEqual([...entries.map((e) => e.id)].sort((a, b) => b - a));
			expect(userTexts([...entries].reverse())).toEqual(["question one", "question two", "question three"]);
		} finally {
			await close();
		}
	});

	test("continues from the oldest entry already shown, without overlap or gaps", async () => {
		const { harness, conversation, close } = await openFauxConversation(
			Array.from({ length: 6 }, (_, i) => fauxAssistantMessage(`answer ${i}`)),
		);
		const controller = createAgentController(harness, conversation);
		const history = createHistory(conversation);
		try {
			for (let i = 0; i < 6; i++) {
				const sent = await controller.prompt({ message: `question ${i}`, images: null }, BACKGROUND_CONTEXT);
				if (!sent.accepted) throw new Error("rejected");
				await controller.waitForPrompt(sent.operationId, BACKGROUND_CONTEXT);
			}
			const everything = (await history.page({ before: null, limit: 200 }, BACKGROUND_CONTEXT))
				.entries as unknown as Entry[];
			const paged: Entry[] = [];
			let before: number | null = null;
			for (let guard = 0; guard < 50; guard++) {
				const page = await history.page({ before, limit: 3 }, BACKGROUND_CONTEXT);
				const entries = page.entries as unknown as Entry[];
				expect(entries.length).toBeLessThanOrEqual(3);
				paged.push(...entries);
				if (!page.more) break;
				before = entries[entries.length - 1]!.id;
			}
			expect(paged.map((e) => e.id)).toEqual(everything.map((e) => e.id));
			expect(new Set(paged.map((e) => e.id)).size).toBe(paged.length);
			// Asking before the very first entry is a finished, empty page.
			await expect(history.page({ before: 1, limit: 5 }, BACKGROUND_CONTEXT)).resolves.toEqual({
				entries: [],
				more: false,
			});
		} finally {
			await close();
		}
	});

	test("bounds the page size and refuses a malformed cursor", async () => {
		const { conversation, close } = await openFauxConversation();
		const history = createHistory(conversation);
		try {
			await expect(history.page({ before: null, limit: 10_000 }, BACKGROUND_CONTEXT)).resolves.toBeDefined();
			await expect(history.page({ before: null, limit: 0 }, BACKGROUND_CONTEXT)).resolves.toBeDefined();
			await expect(history.page({ before: -4, limit: 5 }, BACKGROUND_CONTEXT)).rejects.toThrow(/before/);
			await expect(history.page({ before: 1.5, limit: 5 }, BACKGROUND_CONTEXT)).rejects.toThrow(/before/);
			expect(HISTORY_MAX_PAGE).toBe(200);
		} finally {
			await close();
		}
	});

	test("is served through the service catalogue", async () => {
		const { conversation, close } = await openFauxConversation();
		const host = await createFacetHost({
			facets: [
				defineFacet({
					id: "test-history",
					setup(env) {
						env.provide(History, createHistory(conversation));
					},
				}),
			],
		});
		try {
			expect(host.services.catalogue).toEqual([{ serviceId: History.id, mode: "singleton" }]);
			const result = (await host.services.invoke(
				{ serviceId: History.id, member: "page", args: [{ before: null, limit: 5 }] },
				BACKGROUND_CONTEXT,
			)) as { entries: JsonValue[]; more: boolean };
			expect(Array.isArray(result.entries)).toBe(true);
			expect(typeof result.more).toBe("boolean");
		} finally {
			await host.dispose();
			await close();
		}
	});
});
