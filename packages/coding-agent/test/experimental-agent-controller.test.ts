import { createFacetHost, defineFacet } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { InboxState, LiveState } from "@earendil-works/pi-durable";
import { describe, expect, test } from "vitest";
import { AgentController } from "../src/experimental/services/agent-controller.ts";
import { createAgentController } from "../src/experimental/services/agent-controller-provider.ts";
import { openFauxConversation, pendingResponse } from "./experimental-durable-support.ts";

describe("AgentController service", () => {
	test("prompts the root conversation through the service catalogue", async () => {
		const { harness, conversation, close } = await openFauxConversation([fauxAssistantMessage("hello back")]);
		const host = await createFacetHost({
			facets: [
				defineFacet({
					id: "test-agent-controller",
					setup(env) {
						env.provide(AgentController, createAgentController(harness, conversation));
					},
				}),
			],
		});
		try {
			expect(host.services.catalogue).toEqual([{ serviceId: AgentController.id, mode: "singleton" }]);
			const response = await host.services.invoke(
				{ serviceId: AgentController.id, member: "prompt", args: [{ message: "hello", images: null }] },
				BACKGROUND_CONTEXT,
			);
			expect(response).toEqual({ accepted: true, operationId: expect.any(String), error: null });
			const operationId = (response as { operationId: string }).operationId;
			await expect(
				host.services.invoke(
					{ serviceId: AgentController.id, member: "waitForPrompt", args: [operationId] },
					BACKGROUND_CONTEXT,
				),
			).resolves.toEqual({ status: "done", text: "hello back", reason: null });
		} finally {
			await host.dispose();
			await close();
		}
	});

	test("rejects a prompt while busy and queues steering and follow-up input", async () => {
		const pending = pendingResponse();
		const { harness, conversation, close } = await openFauxConversation([pending.step]);
		const controller = createAgentController(harness, conversation);
		try {
			const first = await controller.prompt({ message: "first", images: null }, BACKGROUND_CONTEXT);
			expect(first.accepted).toBe(true);
			await pending.reached;

			await expect(controller.prompt({ message: "second", images: null }, BACKGROUND_CONTEXT)).resolves.toEqual({
				accepted: false,
				operationId: null,
				error: { code: "busy", message: expect.stringContaining("busy") },
			});
			const steer = await controller.steer({ message: "steer", images: null }, BACKGROUND_CONTEXT);
			const followUp = await controller.followUp({ message: "later", images: null }, BACKGROUND_CONTEXT);
			expect(steer).toEqual({ accepted: true, entryId: expect.any(String), error: null });
			expect(followUp).toEqual({ accepted: true, entryId: expect.any(String), error: null });
			const inbox = await conversation.viewState(BACKGROUND_CONTEXT);
			try {
				expect((inbox.value.docs["pi.inbox"] as InboxState).items.map((item) => item.mode)).toEqual([
					"steer",
					"followUp",
				]);
			} finally {
				inbox.dispose();
			}

			if (!followUp.accepted) throw new Error("Follow-up was rejected");
			await expect(controller.cancelQueued(followUp.entryId, BACKGROUND_CONTEXT)).resolves.toEqual({
				outcome: "cancelled",
			});
			await expect(controller.cancelQueued(followUp.entryId, BACKGROUND_CONTEXT)).resolves.toEqual({
				outcome: "already_consumed",
			});
			await expect(controller.cancelQueued("999", BACKGROUND_CONTEXT)).resolves.toEqual({ outcome: "not_found" });
			await expect(controller.cancelQueued("not-an-id", BACKGROUND_CONTEXT)).resolves.toEqual({
				outcome: "not_found",
			});

			await controller.abort(BACKGROUND_CONTEXT);
			const view = await conversation.viewState(BACKGROUND_CONTEXT);
			try {
				expect((view.value.docs["pi.live"] as LiveState | undefined)?.run).toBeUndefined();
			} finally {
				view.dispose();
			}
			if (!first.accepted) throw new Error("Prompt was rejected");
			await expect(controller.waitForPrompt(first.operationId, BACKGROUND_CONTEXT)).resolves.toMatchObject({
				status: "unanswered",
				text: null,
			});
		} finally {
			await close();
		}
	});

	test("a repeated request key returns the original submission and admits nothing twice", async () => {
		const { harness, conversation, close } = await openFauxConversation([fauxAssistantMessage("once")]);
		const controller = createAgentController(harness, conversation);
		try {
			const request = { message: "hello", images: null, requestId: "client-1" };
			const first = await controller.prompt(request, BACKGROUND_CONTEXT);
			expect(first).toEqual({ accepted: true, operationId: expect.any(String), error: null });
			if (!first.accepted) throw new Error("Prompt was rejected");
			await controller.waitForPrompt(first.operationId, BACKGROUND_CONTEXT);

			// The retry after a lost response, even once the run has finished, is the same submission.
			const retry = await controller.prompt(request, BACKGROUND_CONTEXT);
			expect(retry).toEqual({ accepted: true, operationId: first.operationId, error: null });

			const view = await conversation.viewState(BACKGROUND_CONTEXT);
			try {
				const users = view.value.entries.filter((entry) => entry.model?.[0]?.role === "user");
				expect(users).toHaveLength(1);
			} finally {
				view.dispose();
			}
		} finally {
			await close();
		}
	});

	test("a request key is honored while the conversation is busy, a new key is not", async () => {
		const pending = pendingResponse();
		const { harness, conversation, close } = await openFauxConversation([pending.step]);
		const controller = createAgentController(harness, conversation);
		try {
			const first = await controller.prompt({ message: "first", images: null, requestId: "k1" }, BACKGROUND_CONTEXT);
			if (!first.accepted) throw new Error("Prompt was rejected");
			await pending.reached;
			await expect(
				controller.prompt({ message: "first", images: null, requestId: "k1" }, BACKGROUND_CONTEXT),
			).resolves.toEqual({ accepted: true, operationId: first.operationId, error: null });
			await expect(
				controller.prompt({ message: "other", images: null, requestId: "k2" }, BACKGROUND_CONTEXT),
			).resolves.toMatchObject({ accepted: false, error: { code: "busy" } });
			// Steering and follow-up take keys too.
			const steer = await controller.steer({ message: "steer", images: null, requestId: "s1" }, BACKGROUND_CONTEXT);
			const again = await controller.steer({ message: "steer", images: null, requestId: "s1" }, BACKGROUND_CONTEXT);
			expect(steer).toEqual({ accepted: true, entryId: expect.any(String), error: null });
			expect(again).toEqual(steer);
			await controller.abort(BACKGROUND_CONTEXT);
		} finally {
			await close();
		}
	});

	test("lookup reports a key's submission without ever admitting one", async () => {
		const { harness, conversation, close } = await openFauxConversation([fauxAssistantMessage("answer")]);
		const controller = createAgentController(harness, conversation);
		try {
			await expect(controller.lookup("never-sent", BACKGROUND_CONTEXT)).resolves.toEqual({ found: false });
			// Asking did not create it: still unknown, and the transcript is untouched.
			await expect(controller.lookup("never-sent", BACKGROUND_CONTEXT)).resolves.toEqual({ found: false });
			const empty = await conversation.viewState(BACKGROUND_CONTEXT);
			try {
				expect(empty.value.entries).toHaveLength(0);
			} finally {
				empty.dispose();
			}

			const sent = await controller.prompt(
				{ message: "hello", images: null, requestId: "sent-1" },
				BACKGROUND_CONTEXT,
			);
			if (!sent.accepted) throw new Error("Prompt was rejected");
			await controller.waitForPrompt(sent.operationId, BACKGROUND_CONTEXT);
			await expect(controller.lookup("sent-1", BACKGROUND_CONTEXT)).resolves.toEqual({
				found: true,
				operationId: sent.operationId,
				status: "done",
				reason: null,
				detail: null,
			});
		} finally {
			await close();
		}
	});

	test("lookup reports a run in progress as placed and an aborted one as unanswered", async () => {
		const pending = pendingResponse();
		const { harness, conversation, close } = await openFauxConversation([pending.step]);
		const controller = createAgentController(harness, conversation);
		try {
			const sent = await controller.prompt({ message: "work", images: null, requestId: "w1" }, BACKGROUND_CONTEXT);
			if (!sent.accepted) throw new Error("Prompt was rejected");
			await pending.reached;
			await expect(controller.lookup("w1", BACKGROUND_CONTEXT)).resolves.toMatchObject({
				found: true,
				operationId: sent.operationId,
				status: "placed",
			});
			await controller.abort(BACKGROUND_CONTEXT);
			await controller.waitForPrompt(sent.operationId, BACKGROUND_CONTEXT);
			await expect(controller.lookup("w1", BACKGROUND_CONTEXT)).resolves.toMatchObject({
				found: true,
				status: "unanswered",
				reason: "aborted",
				detail: null,
			});
		} finally {
			await close();
		}
	});

	test("lookup carries the model's error text for a run that failed", async () => {
		const { harness, conversation, close } = await openFauxConversation([
			fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider unavailable" }),
		]);
		const controller = createAgentController(harness, conversation);
		try {
			const sent = await controller.prompt({ message: "go", images: null, requestId: "e1" }, BACKGROUND_CONTEXT);
			if (!sent.accepted) throw new Error("Prompt was rejected");
			await controller.waitForPrompt(sent.operationId, BACKGROUND_CONTEXT);
			await expect(controller.lookup("e1", BACKGROUND_CONTEXT)).resolves.toMatchObject({
				found: true,
				status: "unanswered",
				reason: "model_error",
				detail: expect.stringContaining("provider unavailable"),
			});
		} finally {
			await close();
		}
	});

	test("starts a compaction task", async () => {
		const { harness, conversation, close } = await openFauxConversation();
		const controller = createAgentController(harness, conversation);
		try {
			await expect(controller.compact({ customInstructions: "short" }, BACKGROUND_CONTEXT)).resolves.toEqual({
				accepted: true,
				operationId: expect.any(String),
				error: null,
			});
		} finally {
			await close();
		}
	});
});
