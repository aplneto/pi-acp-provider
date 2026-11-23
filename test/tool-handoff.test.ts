import test from "node:test";
import assert from "node:assert/strict";
import { ToolHandoff } from "../src/tool-handoff.ts";

test("independent handoffs keep pending tool results isolated", async () => {
	const left = new ToolHandoff();
	const right = new ToolHandoff();
	const first = left.request({ id: "same", name: "read", arguments: { path: "left" } });
	const second = right.request({ id: "same", name: "read", arguments: { path: "right" } });
	assert.equal((await left.next())?.arguments.path, "left");
	assert.equal((await right.next())?.arguments.path, "right");
	assert.equal(right.complete("same", "right result"), true);
	assert.equal(left.complete("same", "left result"), true);
	assert.deepEqual(await Promise.all([first, second]), ["left result", "right result"]);
	assert.equal(left.complete("same", "late"), false);
	left.close(); right.close();
});

test("abort and close reject pending work and unblock a waiting consumer", async () => {
	const bridge = new ToolHandoff();
	const controller = new AbortController();
	const pending = bridge.request({ id: "one", name: "read", arguments: {} }, controller.signal);
	controller.abort();
	await assert.rejects(pending, /aborted/);
	assert.equal(bridge.complete("one", "late"), false);
	const next = bridge.next();
	bridge.close("session ended");
	assert.equal(await next, undefined);
	await assert.rejects(bridge.request({ id: "two", name: "read", arguments: {} }), /session ended/);
});
