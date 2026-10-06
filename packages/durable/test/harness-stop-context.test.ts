import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, chatSetup, openChat, textOf, unanswered } from "./chat-support.ts";
import { ControlledStorage, context } from "./session-support.ts";

it("commits retirement with aborted settlement once, without changing the stored user entry", async () => {
	const storage = new ControlledStorage();
	const setup = chatSetup();
	const blocked = unanswered();
	setup.faux.setResponses([blocked.step]);
	const { harness, root } = await openChat(storage, setup);
	try {
		const submission = await root.submit({ type: "input", content: "commit and push" }, context);
		await blocked.reached;
		const original = (await allEntries(root))[0]!;
		await root.abort(context);
		expect(
			storage.commits.some(
				(writes) =>
					writes.some(
						(write) =>
							write.type === "submission" &&
							write.value.id === submission.id &&
							write.value.status === "unanswered",
					) && writes.some((write) => write.type === "entry" && write.value.kind === "pi.cancelled-input"),
			),
		).toBe(true);
		await root.abort(context);
		const entries = await allEntries(root);
		expect(entries.filter((entry) => entry.kind === "pi.cancelled-input")).toHaveLength(1);
		expect(entries.find((entry) => entry.id === original.id)).toEqual(original);
	} finally {
		await harness.close(context);
	}
});

it.each(["count to 100", "Pursue this ongoing goal: count to 100"])(
	"retires a stopped instruction before replacement input: %s",
	async (replacement) => {
		const directory = await mkdtemp(join(tmpdir(), "pi-stop-context-"));
		const path = join(directory, "session.sqlite");
		const setup = chatSetup();
		const blocked = unanswered();
		setup.faux.setResponses([
			fauxAssistantMessage("Earlier task complete"),
			blocked.step,
			(view) => {
				const users = view.messages.filter((message) => message.role === "user").map(textOf);
				expect(users).toEqual(["earlier completed task", replacement]);
				return fauxAssistantMessage("1 2 3 ... 100");
			},
		]);
		let opened = await openChat(await openNodeSqliteStorage(path), setup);
		try {
			await (await opened.root.submit({ type: "input", content: "earlier completed task" }, context)).wait(context);
			const stopped = await opened.root.submit(
				{ type: "input", content: "commit and push", requestId: "stopped" },
				context,
			);
			await blocked.reached;
			const queued = await opened.root.submit(
				{ type: "input", content: "also publish", whenBusy: "followUp" },
				context,
			);
			await opened.root.abort(context);
			expect(await stopped.status(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
			expect(await queued.status(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
			const view = await opened.root.context(context);
			expect(view.messages.filter((message) => message.role === "user").map(textOf)).toEqual([
				"earlier completed task",
			]);
			// Keep the audit trail, not a live instruction; the retirement must survive reopening.
			expect(
				(await allEntries(opened.root)).some((entry) =>
					entry.model?.some((message) => textOf(message) === "commit and push"),
				),
			).toBe(true);
			await opened.harness.close(context);
			opened = await openChat(await openNodeSqliteStorage(path), setup);
			const next = await opened.root.submit({ type: "input", content: replacement }, context);
			expect(await next.wait(context)).toMatchObject({ status: "done" });
		} finally {
			await opened.harness.close(context);
			await rm(directory, { recursive: true, force: true });
		}
	},
);
