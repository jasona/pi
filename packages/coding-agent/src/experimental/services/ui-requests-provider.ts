import {
	type Context,
	defineFacet,
	type Facet,
	type JsonValue,
	type MutableReplicatedState,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	UI_DEFAULT_TIMEOUT_MS,
	UI_MAX_INPUT_CHARS,
	UI_MAX_NOTICES,
	UI_MAX_PENDING,
	UI_MAX_TITLE_CHARS,
	type UiAskOptions,
	type UiNotice,
	type UiRequest,
	UiRequestHost,
	type UiRequestItem,
	type UiRequestKind,
	UiRequests,
	type UiRequestsState,
	type UiRespondResult,
} from "./ui-requests.ts";

interface Pending {
	request: UiRequest;
	settle(value: JsonValue | undefined): void;
	dispose(): void;
}

export interface UiRequestsRuntime {
	readonly service: UiRequests;
	readonly host: UiRequestHost;
	cancelAll(reason: string): void;
}

/** The implementation behind `UiRequests` and `UiRequestHost`; `now` and the timers are injectable for tests. */
export function createUiRequests(
	createState: (initial: UiRequestsState) => MutableReplicatedState<UiRequestsState>,
	now: () => number = Date.now,
): UiRequestsRuntime {
	const state = createState({ requests: [], status: {}, notices: [] });
	const pending = new Map<string, Pending>();
	let counter = 0;

	const change = (edit: (draft: UiRequestsState) => void): void => {
		state.change(BACKGROUND_CONTEXT, edit);
	};
	const notify = (level: UiNotice["level"], message: string): void => {
		const notice: UiNotice = { id: `n${++counter}`, level, message: message.slice(0, 500), at: now() };
		change((draft) => {
			draft.notices.push(notice);
			while (draft.notices.length > UI_MAX_NOTICES) draft.notices.shift();
		});
	};
	const remove = (id: string): void => {
		pending.delete(id);
		change((draft) => {
			const at = draft.requests.findIndex((r) => r.id === id);
			if (at >= 0) draft.requests.splice(at, 1);
		});
	};

	function ask<T>(
		kind: UiRequestKind,
		title: string,
		fields: Partial<Pick<UiRequest, "items" | "placeholder" | "defaultValue">>,
		options: UiAskOptions | undefined,
		context: Context,
		convert: (value: JsonValue | undefined) => T | undefined,
	): Promise<T | undefined> {
		if (pending.size >= UI_MAX_PENDING) {
			notify("warning", `Too many open questions; "${title.slice(0, 80)}" was not shown.`);
			return Promise.resolve(undefined);
		}
		const id = `q${++counter}`;
		const timeout = options?.timeoutMs ?? UI_DEFAULT_TIMEOUT_MS;
		const createdAt = now();
		const request: UiRequest = {
			id,
			kind,
			title: title.slice(0, UI_MAX_TITLE_CHARS),
			message: options?.message?.slice(0, 2000) ?? null,
			items: fields.items ?? null,
			placeholder: fields.placeholder ?? null,
			defaultValue: fields.defaultValue ?? null,
			createdAt,
			deadline: timeout > 0 ? createdAt + timeout : null,
		};
		return new Promise<T | undefined>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = (): void => entry.settle(undefined);
			const entry: Pending = {
				request,
				settle(value) {
					entry.dispose();
					remove(id);
					resolve(convert(value));
				},
				dispose() {
					if (timer !== undefined) clearTimeout(timer);
					context.abortSignal?.removeEventListener("abort", onAbort);
				},
			};
			pending.set(id, entry);
			change((draft) => {
				draft.requests.push(request);
			});
			if (timeout > 0) {
				timer = setTimeout(() => {
					notify("info", `No answer to "${request.title.slice(0, 80)}"; it was cancelled.`);
					entry.settle(undefined);
				}, timeout);
				timer.unref?.();
			}
			if (context.abortSignal?.aborted) onAbort();
			else context.abortSignal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	const host: UiRequestHost = {
		select(title, items, options, context) {
			const list: UiRequestItem[] = items.map((i) => ({
				value: String(i.value),
				label: String(i.label),
				description: i.description === undefined ? null : String(i.description),
			}));
			if (list.length === 0) return Promise.resolve(undefined);
			return ask("select", title, { items: list }, options, context, (v) => (typeof v === "string" ? v : undefined));
		},
		confirm(title, options, context) {
			return ask("confirm", title, {}, options, context, (v) => (typeof v === "boolean" ? v : undefined));
		},
		input(title, options, context) {
			return ask(
				"input",
				title,
				{ placeholder: options?.placeholder ?? null, defaultValue: options?.defaultValue ?? null },
				options,
				context,
				(v) => (typeof v === "string" ? v : undefined),
			);
		},
		notify,
		setStatus(key, text) {
			change((draft) => {
				if (text === null) delete draft.status[key];
				else draft.status[String(key).slice(0, 80)] = String(text).slice(0, 300);
			});
		},
	};

	const service: UiRequests = {
		state,
		async respond(id, value, _context): Promise<UiRespondResult> {
			const entry = pending.get(String(id));
			if (entry === undefined) return { accepted: false, reason: "That question is no longer open." };
			const { request } = entry;
			if (request.kind === "confirm") {
				if (typeof value !== "boolean") return { accepted: false, reason: "A confirmation needs yes or no." };
			} else if (typeof value !== "string") {
				return { accepted: false, reason: "An answer must be text." };
			} else if (request.kind === "select" && !request.items?.some((item) => item.value === value)) {
				return { accepted: false, reason: "That is not one of the choices." };
			} else if (request.kind === "input" && value.length > UI_MAX_INPUT_CHARS) {
				return { accepted: false, reason: `An answer can be at most ${UI_MAX_INPUT_CHARS} characters.` };
			}
			entry.settle(value);
			return { accepted: true, reason: null };
		},
		async cancel(id) {
			const entry = pending.get(String(id));
			if (entry === undefined) return { cancelled: false };
			entry.settle(undefined);
			return { cancelled: true };
		},
	};

	return {
		service,
		host,
		cancelAll(reason) {
			for (const entry of [...pending.values()]) entry.settle(undefined);
			if (reason) notify("info", reason);
		},
	};
}

/** Serve `UiRequests` to presentations and `UiRequestHost` to the session's other facets. */
export function createUiRequestsServiceFacet(): Facet {
	return defineFacet({
		id: "@pi/ui-requests",
		setup(env) {
			const runtime = createUiRequests(env.replicatedState);
			env.own(() => runtime.cancelAll(""));
			env.provide(UiRequests, runtime.service);
			env.provide(UiRequestHost, runtime.host);
		},
	});
}
