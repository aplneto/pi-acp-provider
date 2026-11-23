/** A pending request from an ACP-side tool bridge to the owning Pi session. */
export interface ToolHandoffCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/**
 * Holds tool calls while a Pi provider stream yields to the agent loop.
 * One instance belongs to one ACP turn; closing it rejects every pending call.
 */
export class ToolHandoff {
	private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private readonly ready: ToolHandoffCall[] = [];
	private waiter: ((call: ToolHandoffCall | undefined) => void) | undefined;
	private closed: Error | undefined;

	request(call: ToolHandoffCall, signal?: AbortSignal): Promise<unknown> {
		if (this.closed) return Promise.reject(this.closed);
		if (signal?.aborted) return Promise.reject(new Error("Tool request aborted"));
		if (this.pending.has(call.id)) return Promise.reject(new Error("Duplicate tool request id"));
		return new Promise((resolve, reject) => {
			const abort = () => {
				this.pending.delete(call.id);
				const index = this.ready.indexOf(call);
				if (index >= 0) this.ready.splice(index, 1);
				reject(new Error("Tool request aborted"));
			};
			this.pending.set(call.id, {
				resolve: (value) => { signal?.removeEventListener("abort", abort); resolve(value); },
				reject: (error) => { signal?.removeEventListener("abort", abort); reject(error); },
			});
			signal?.addEventListener("abort", abort, { once: true });
			if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(call); }
			else this.ready.push(call);
		});
	}

	next(): Promise<ToolHandoffCall | undefined> {
		const call = this.ready.shift();
		if (call || this.closed) return Promise.resolve(call);
		if (this.waiter) return Promise.reject(new Error("A tool handoff consumer is already waiting"));
		return new Promise((resolve) => { this.waiter = resolve; });
	}

	complete(id: string, result: unknown): boolean {
		const entry = this.pending.get(id);
		if (!entry) return false;
		this.pending.delete(id);
		const index = this.ready.findIndex((call) => call.id === id);
		if (index >= 0) this.ready.splice(index, 1);
		entry.resolve(result);
		return true;
	}

	close(reason = "Tool handoff closed"): void {
		if (this.closed) return;
		this.closed = new Error(reason);
		this.ready.length = 0;
		for (const entry of this.pending.values()) entry.reject(this.closed);
		this.pending.clear();
		this.waiter?.(undefined);
		this.waiter = undefined;
	}
}
