import type { Context } from "@earendil-works/chord";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	type Conversation,
	ConversationBusy,
	type Harness,
	type SubmissionId,
	type UserInput,
} from "@earendil-works/pi-durable";
import type {
	AgentController as AgentControllerService,
	AgentOperationError,
	AgentPromptRequest,
	AgentPromptResult,
	AgentQueueResponse,
	AgentRequestStatus,
} from "./agent-controller.ts";

export function createAgentController(harness: Harness, conversation: Conversation): AgentControllerService {
	const queue = async (
		whenBusy: "steer" | "followUp",
		request: AgentPromptRequest,
		context: Context,
	): Promise<AgentQueueResponse> => {
		try {
			const submission = await conversation.submit(
				{ type: "input", content: toInput(request), whenBusy, ...requestKey(request) },
				context,
			);
			return { accepted: true, entryId: String(submission.id), error: null };
		} catch (error) {
			return { accepted: false, entryId: null, error: toAgentError(error) };
		}
	};

	return {
		async prompt(request, context) {
			try {
				const submission = await conversation.submit(
					{ type: "input", content: toInput(request), whenBusy: "reject", ...requestKey(request) },
					context,
				);
				return { accepted: true, operationId: String(submission.id), error: null };
			} catch (error) {
				return { accepted: false, operationId: null, error: toAgentError(error) };
			}
		},
		steer: (request, context) => queue("steer", request, context),
		followUp: (request, context) => queue("followUp", request, context),
		async cancelQueued(entryId, context) {
			const id = parseSubmissionId(entryId);
			if (id === undefined) return { outcome: "not_found" };
			const result = await harness.abortSubmission(id, context, conversation.id);
			return {
				outcome: result === "aborted" ? "cancelled" : result === "not_found" ? "not_found" : "already_consumed",
			};
		},
		abort: (context) => conversation.abort(context),
		async lookup(requestId, context): Promise<AgentRequestStatus> {
			const submission = await harness.submissionByRequest(conversation.id, requestId, context);
			if (submission === undefined) return { found: false };
			const record = await submission.status(context);
			return {
				found: true,
				operationId: String(record.id),
				status: record.status,
				reason: record.status === "unanswered" ? String(record.reason) : null,
				detail:
					record.status === "unanswered" && record.detail !== undefined
						? typeof record.detail === "string"
							? record.detail
							: JSON.stringify(record.detail)
						: null,
			};
		},
		async compact(request, context) {
			try {
				const id = await conversation.compact(request.customInstructions ?? undefined, context);
				return { accepted: true, operationId: String(id), error: null };
			} catch (error) {
				return { accepted: false, operationId: null, error: toAgentError(error) };
			}
		},
		async waitForPrompt(operationId, context): Promise<AgentPromptResult> {
			const id = parseSubmissionId(operationId);
			const submission = id === undefined ? undefined : await harness.submission(id, context);
			if (submission === undefined) throw new Error(`Unknown prompt: ${operationId}`);
			const settled = await submission.wait(context);
			if (settled.status === "unanswered") return { status: "unanswered", text: null, reason: settled.reason };
			const answer = settled.type === "input" ? settled.answer : undefined;
			const message =
				answer === undefined ? undefined : (await harness.commit((tx) => tx.entry(answer), context))?.model?.[0];
			const text =
				message?.role === "assistant"
					? message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("")
					: "";
			return { status: "done", text, reason: null };
		},
	};
}

function parseSubmissionId(value: string): SubmissionId | undefined {
	const id = Number(value);
	return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(id) ? (id as SubmissionId) : undefined;
}

/** The durable request key, only when the caller supplied a non-empty one. */
function requestKey(request: AgentPromptRequest): { requestId?: string } {
	return typeof request.requestId === "string" && request.requestId.length > 0 ? { requestId: request.requestId } : {};
}

function toInput(request: AgentPromptRequest): UserInput {
	if (request.images === null || request.images.length === 0) return request.message;
	const content: (TextContent | ImageContent)[] = [{ type: "text", text: request.message }, ...request.images];
	return content;
}

function toAgentError(error: unknown): AgentOperationError {
	if (error instanceof ConversationBusy) return { code: "busy", message: error.message };
	return { code: "operation_failed", message: error instanceof Error ? error.message : String(error) };
}
