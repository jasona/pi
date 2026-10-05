import { createFacetHost, defineFacet, replicatedState } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	UI_DEFAULT_TIMEOUT_MS,
	UI_MAX_PENDING,
	UiRequestHost,
	UiRequests,
	type UiRequestsState,
} from "../src/experimental/services/ui-requests.ts";
import { createUiRequests, createUiRequestsServiceFacet } from "../src/experimental/services/ui-requests-provider.ts";

const make = () => createUiRequests((initial: UiRequestsState) => replicatedState(initial));
const ctx = BACKGROUND_CONTEXT;
const current = (ui: ReturnType<typeof make>): UiRequestsState => ui.service.state.value as UiRequestsState;

describe("UiRequests", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("a select waits for a presentation's answer, which must be one of its choices", async () => {
		const ui = make();
		const answer = ui.host.select(
			"Pick a branch",
			[
				{ value: "main", label: "main" },
				{ value: "dev", label: "dev", description: "work in progress" },
			],
			undefined,
			ctx,
		);
		const [request] = current(ui).requests;
		expect(request).toMatchObject({ kind: "select", title: "Pick a branch", deadline: expect.any(Number) });
		expect(request!.items).toEqual([
			{ value: "main", label: "main", description: null },
			{ value: "dev", label: "dev", description: "work in progress" },
		]);
		// A wrong answer is refused and the question stays open.
		await expect(ui.service.respond(request!.id, "nope", ctx)).resolves.toEqual({
			accepted: false,
			reason: "That is not one of the choices.",
		});
		await expect(ui.service.respond(request!.id, true, ctx)).resolves.toMatchObject({ accepted: false });
		expect(current(ui).requests).toHaveLength(1);
		await expect(ui.service.respond(request!.id, "dev", ctx)).resolves.toEqual({ accepted: true, reason: null });
		await expect(answer).resolves.toBe("dev");
		expect(current(ui).requests).toEqual([]);
		// Answering twice is refused.
		await expect(ui.service.respond(request!.id, "dev", ctx)).resolves.toMatchObject({ accepted: false });
	});

	test("confirm and input take their own kinds of answer", async () => {
		const ui = make();
		const yes = ui.host.confirm("Delete it?", { message: "This cannot be undone" }, ctx);
		const text = ui.host.input("Name?", { placeholder: "a name", defaultValue: "x" }, ctx);
		const [confirm, input] = current(ui).requests;
		expect(confirm).toMatchObject({ kind: "confirm", message: "This cannot be undone" });
		expect(input).toMatchObject({ kind: "input", placeholder: "a name", defaultValue: "x" });
		await expect(ui.service.respond(confirm!.id, "yes", ctx)).resolves.toMatchObject({ accepted: false });
		await expect(ui.service.respond(confirm!.id, false, ctx)).resolves.toMatchObject({ accepted: true });
		await expect(ui.service.respond(input!.id, 7, ctx)).resolves.toMatchObject({ accepted: false });
		await expect(ui.service.respond(input!.id, "y".repeat(10_001), ctx)).resolves.toMatchObject({
			accepted: false,
		});
		await expect(ui.service.respond(input!.id, "ada", ctx)).resolves.toMatchObject({ accepted: true });
		await expect(yes).resolves.toBe(false);
		await expect(text).resolves.toBe("ada");
	});

	test("an unanswered question is cancelled at its deadline, so an extension never waits forever", async () => {
		const ui = make();
		const answer = ui.host.confirm("Proceed?", undefined, ctx);
		expect(current(ui).requests[0]!.deadline! - current(ui).requests[0]!.createdAt).toBe(UI_DEFAULT_TIMEOUT_MS);
		await vi.advanceTimersByTimeAsync(UI_DEFAULT_TIMEOUT_MS + 1);
		await expect(answer).resolves.toBeUndefined();
		expect(current(ui).requests).toEqual([]);
		expect(current(ui).notices.at(-1)).toMatchObject({
			level: "info",
			message: expect.stringContaining("Proceed?"),
		});
		// A caller's own timeout, and no timeout at all.
		const short = ui.host.confirm("Quick?", { timeoutMs: 50 }, ctx);
		const forever = ui.host.confirm("Patient?", { timeoutMs: 0 }, ctx);
		await vi.advanceTimersByTimeAsync(60);
		await expect(short).resolves.toBeUndefined();
		expect(current(ui).requests.map((r) => r.title)).toEqual(["Patient?"]);
		expect(current(ui).requests[0]!.deadline).toBeNull();
		ui.cancelAll("done");
		await expect(forever).resolves.toBeUndefined();
	});

	test("cancelling, aborting and shutting down all release the waiting extension", async () => {
		const ui = make();
		const a = ui.host.confirm("A?", undefined, ctx);
		const id = current(ui).requests[0]!.id;
		await expect(ui.service.cancel(id, ctx)).resolves.toEqual({ cancelled: true });
		await expect(ui.service.cancel(id, ctx)).resolves.toEqual({ cancelled: false });
		await expect(a).resolves.toBeUndefined();

		const controller = new AbortController();
		const b = ui.host.confirm("B?", undefined, { ...ctx, abortSignal: controller.signal });
		expect(current(ui).requests).toHaveLength(1);
		controller.abort();
		await expect(b).resolves.toBeUndefined();
		expect(current(ui).requests).toEqual([]);

		const alreadyAborted = new AbortController();
		alreadyAborted.abort();
		await expect(
			ui.host.confirm("C?", undefined, { ...ctx, abortSignal: alreadyAborted.signal }),
		).resolves.toBeUndefined();

		const d = ui.host.input("D?", undefined, ctx);
		const e = ui.host.select("E?", [{ value: "1", label: "one" }], undefined, ctx);
		ui.cancelAll("The session ended.");
		await expect(Promise.all([d, e])).resolves.toEqual([undefined, undefined]);
		expect(current(ui).requests).toEqual([]);
	});

	test("the number of open questions is bounded", async () => {
		const ui = make();
		const open = Array.from({ length: UI_MAX_PENDING }, (_, i) => ui.host.confirm(`Q${i}`, { timeoutMs: 0 }, ctx));
		expect(current(ui).requests).toHaveLength(UI_MAX_PENDING);
		await expect(ui.host.confirm("one too many", undefined, ctx)).resolves.toBeUndefined();
		expect(current(ui).requests).toHaveLength(UI_MAX_PENDING);
		expect(current(ui).notices.at(-1)!.message).toContain("Too many open questions");
		ui.cancelAll("");
		await Promise.all(open);
	});

	test("an empty select is not shown and notices stay bounded", async () => {
		const ui = make();
		await expect(ui.host.select("Nothing to pick", [], undefined, ctx)).resolves.toBeUndefined();
		expect(current(ui).requests).toEqual([]);
		for (let i = 0; i < 40; i++) ui.host.notify("warning", `note ${i}`);
		expect(current(ui).notices).toHaveLength(20);
		expect(current(ui).notices.at(-1)!.message).toBe("note 39");
		ui.host.setStatus("build", "compiling");
		ui.host.setStatus("lint", "clean");
		ui.host.setStatus("build", null);
		expect(current(ui).status).toEqual({ lint: "clean" });
	});

	test("only the presentation-facing service is in the RPC catalogue; the host stays local", async () => {
		const host = await createFacetHost({ facets: [createUiRequestsServiceFacet()] });
		try {
			expect(host.services.catalogue).toEqual([{ serviceId: UiRequests.id, mode: "singleton" }]);
		} finally {
			await host.dispose();
		}
	});

	test("another facet asks through the host and a remote answer reaches it", async () => {
		let result: Promise<string | undefined> | undefined;
		const asker = defineFacet({
			id: "test-asker",
			setup(env) {
				const ui = env.use(UiRequestHost);
				env.onActivate(() => {
					result = ui.select("Which?", [{ value: "a", label: "A" }], undefined, ctx);
				});
			},
		});
		const host = await createFacetHost({ facets: [createUiRequestsServiceFacet(), asker] });
		try {
			await vi.advanceTimersByTimeAsync(0);
			const answer = (await host.services.invoke(
				{ serviceId: UiRequests.id, member: "respond", args: ["q1", "a"] },
				ctx,
			)) as { accepted: boolean };
			expect(answer.accepted).toBe(true);
			await expect(result).resolves.toBe("a");
		} finally {
			await host.dispose();
		}
	});
});
