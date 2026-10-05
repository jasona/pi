import { type Context, defineService } from "@earendil-works/chord";

export interface AgentPromptImage {
	type: "image";
	data: string;
	mimeType: string;
}

export interface AgentPromptRequest {
	message: string;
	images: AgentPromptImage[] | null;
	/**
	 * Optional client-chosen idempotency key, scoped to the conversation. Repeating a key returns the original
	 * submission instead of admitting the input again, so a client that lost a response can retry safely or ask
	 * `lookup()` whether the input arrived. The key identifies the request, not its content: pick a fresh key for
	 * different content.
	 */
	requestId?: string | null;
}

export interface AgentOperationError {
	code: string;
	message: string;
}

/** `operationId` identifies the durable submission of a prompt, or the task of a compaction. */
export type AgentOperationResponse =
	| { accepted: true; operationId: string; error: null }
	| { accepted: false; operationId: null; error: AgentOperationError };

/** `entryId` identifies the durable submission; `cancelQueued()` withdraws it while it is still queued. */
export type AgentQueueResponse =
	| { accepted: true; entryId: string; error: null }
	| { accepted: false; entryId: null; error: AgentOperationError };

/** The settled outcome of a prompt: the answer's text, or why it got none. */
export type AgentPromptResult =
	| { status: "done"; text: string; reason: null }
	| { status: "unanswered"; text: null; reason: string };

/**
 * What the conversation knows about a request key. `found: false` means no submission carries it now, which is
 * not proof it never arrived if the engine's record could have been lost; within one durable conversation it is.
 */
export type AgentRequestStatus =
	| { found: false }
	| {
			found: true;
			/** The durable submission: the same id `prompt()` returned (or would have). */
			operationId: string;
			/** `queued`: admitted behind a run. `placed`: running. `done`/`unanswered`: settled. */
			status: "queued" | "placed" | "done" | "unanswered";
			/** Why an `unanswered` submission got no answer: `aborted`, `model_error`, `no_model` or `stale`. */
			reason: string | null;
			/** The failure's text when the engine recorded one (for example the model's error message). */
			detail: string | null;
	  };

export interface AgentCompactionRequest {
	customInstructions: string | null;
}

/** Presentation-safe command facade over the worker-owned root conversation. */
export interface AgentController {
	/** Start a run; rejected with `busy` while one is active. */
	prompt(request: AgentPromptRequest, context: Context): Promise<AgentOperationResponse>;
	/** Steer the active run, or start one when idle. */
	steer(request: AgentPromptRequest, context: Context): Promise<AgentQueueResponse>;
	/** Queue input for after the active run, or start one when idle. */
	followUp(request: AgentPromptRequest, context: Context): Promise<AgentQueueResponse>;
	cancelQueued(
		entryId: string,
		context: Context,
	): Promise<{ outcome: "cancelled" | "already_consumed" | "not_found" }>;
	/** Withdraw queued input and abort the active run and compaction. */
	abort(context: Context): Promise<void>;
	compact(request: AgentCompactionRequest, context: Context): Promise<AgentOperationResponse>;
	/** Ask whether a request key reached this conversation, without admitting anything. */
	lookup(requestId: string, context: Context): Promise<AgentRequestStatus>;
	/** Wait until the prompt with this `operationId` is answered or settles unanswered. */
	waitForPrompt(operationId: string, context: Context): Promise<AgentPromptResult>;
}

export const AgentController = defineService<AgentController>("pi.agent-controller");
