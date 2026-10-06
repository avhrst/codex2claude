import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { Broker, startBroker } from "../dist/broker.js";
import { initConfig, publicBinding } from "../dist/config.js";
import { rpc } from "../dist/ipc.js";
import { snapshot } from "../dist/snapshot.js";

const cli = new URL("../dist/cli.js", import.meta.url).pathname;
const architecture = {
  kind: "architecture",
  architecture: "Two native hosts, two MCP adapters and a local broker.",
  alternatives: [],
  contracts: ["Same task/snapshot correlation."],
  implementation: ["Load channel."],
  risks: ["Native consent."],
  verification: ["Real handshake."],
  clarifications: [],
};
const request = {
  idempotency_key: "one",
  goal: "Architecture fixture",
  files: [],
};
function fixture(t) {
  const root = mkdtempSync("/private/tmp/c2c-test-");
  const c = initConfig(root);
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(c.socket, ".."), { recursive: true, force: true });
  });
  return { root, c, b: new Broker(c) };
}
async function ready(b, lease = "fixture-lease") {
  await b.call("claude", "register", { lease });
  const p = await b.call("claude", "poll", { lease });
  await b.call("claude", "channel_ready", { lease, nonce: p.event.nonce });
  return lease;
}
async function accept(b, id, lease) {
  const e = (await b.call("claude", "poll", { lease })).event;
  b.written(e.task_id, lease);
  await b.call("claude", "accept_task", {
    task_id: id,
    snapshot_id: e.snapshot_id,
    lease,
  });
  return { task_id: id, snapshot_id: e.snapshot_id, lease };
}

test("idempotency, explicit acceptance and correlated result survive restart", async (t) => {
  const { b, c } = fixture(t);
  const receipt = await b.call("codex", "request_architecture", request);
  assert.equal(
    (await b.call("codex", "request_architecture", request)).task_id,
    receipt.task_id,
  );
  await assert.rejects(
    b.call("codex", "request_architecture", { ...request, goal: "different" }),
    /idempotency_conflict/,
  );
  const lease = await ready(b);
  const a = await accept(b, receipt.task_id, lease);
  assert.equal((await b.call("claude", "accept_task", a)).execute, false);
  await assert.rejects(
    b.call("claude", "submit_result", {
      ...a,
      snapshot_id: "wrong",
      result: architecture,
    }),
    /snapshot_mismatch/,
  );
  await b.call("claude", "submit_result", { ...a, result: architecture });
  await b.call("claude", "submit_result", { ...a, result: architecture });
  await assert.rejects(
    b.call("claude", "submit_result", {
      ...a,
      result: { ...architecture, architecture: "Conflicting" },
    }),
    /result_conflict/,
  );
  const restarted = new Broker(c);
  assert.equal(
    (await restarted.call("codex", "task_result", { task_id: a.task_id }))
      .result.architecture,
    architecture.architecture,
  );
  assert.equal(
    (await restarted.call("codex", "bridge_status", {})).ready,
    false,
  );
});
test("offline participant stays queued; heartbeat is not readiness; uncertain delivery requires reconciliation", async (t) => {
  const { b, c } = fixture(t);
  const r = await b.call("codex", "request_architecture", request);
  assert.equal(
    (await b.call("codex", "task_status", { task_id: r.task_id })).state,
    "queued",
  );
  await b.call("claude", "register", { lease: "first" });
  assert.equal((await b.call("codex", "bridge_status", {})).ready, false);
  const hello = (await b.call("claude", "poll", { lease: "first" })).event;
  await assert.rejects(
    b.call("claude", "channel_ready", { lease: "first", nonce: "wrong" }),
    /nonce_mismatch/,
  );
  await b.call("claude", "channel_ready", {
    lease: "first",
    nonce: hello.nonce,
  });
  const event = (await b.call("claude", "poll", { lease: "first" })).event;
  assert.equal(event.task_id, r.task_id);
  assert.equal(
    (await b.call("claude", "poll", { lease: "first" })).event,
    null,
  );
  const restarted = new Broker(c);
  const lease = await ready(restarted, "second");
  assert.equal((await restarted.call("claude", "poll", { lease })).event, null);
  await restarted.call("codex", "reconcile_delivery", {
    task_id: r.task_id,
    decision: "retry",
  });
  assert.equal(
    (await restarted.call("claude", "poll", { lease })).event.task_id,
    r.task_id,
  );
});
test("cooperative cancellation, bounded wait and late result", async (t) => {
  const { b } = fixture(t);
  const r = await b.call("codex", "request_architecture", request);
  const lease = await ready(b);
  const a = await accept(b, r.task_id, lease);
  await b.call("codex", "cancel_task", {
    task_id: r.task_id,
    reason: "Human cancelled",
  });
  assert.equal(
    (
      await b.call("codex", "wait_for_task", {
        task_id: r.task_id,
        timeout_seconds: 0.1,
      })
    ).state,
    "cancel_requested",
  );
  await b.call("claude", "submit_result", { ...a, result: architecture });
  const late = await b.call("codex", "task_result", { task_id: r.task_id });
  assert.equal(late.state, "cancel_requested");
  assert.equal(late.result_receipt.late, true);
  assert.equal(late.result, null);
  assert.equal(late.late_result.architecture, architecture.architecture);
  await b.call("claude", "acknowledge_cancel", a);
  assert.equal(
    (await b.call("codex", "task_status", { task_id: r.task_id })).state,
    "cancelled",
  );
});
test("deadline, acceptance binding and no automatic accepted replay after crash", async (t) => {
  const { b, c } = fixture(t);
  const r = await b.call("codex", "request_architecture", request);
  const lease = await ready(b);
  const a = await accept(b, r.task_id, lease);
  await assert.rejects(
    b.call("claude", "task_context", { ...a, lease: "other" }),
    /lease_mismatch/,
  );
  const restarted = new Broker(c);
  assert.equal(
    (await restarted.call("codex", "task_status", { task_id: r.task_id }))
      .state,
    "needs_human",
  );
  const other = await ready(restarted, "new");
  assert.equal(
    (await restarted.call("claude", "poll", { lease: other })).event,
    null,
  );
  b.task(r.task_id).deadline = Date.now() - 1;
  assert.equal(
    (await b.call("codex", "task_status", { task_id: r.task_id })).state,
    "expired",
  );
  await b.call("claude", "submit_result", { ...a, result: architecture });
  assert.equal(
    (await b.call("codex", "task_result", { task_id: r.task_id }))
      .result_receipt.late,
    true,
  );
});
test("immutable explicit snapshot, UTF-8 bytes, secret/size/path/symlink boundaries", async (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, "a.txt"), "Привіт\n");
  const s = snapshot(root, ["a.txt"]);
  assert.equal(s.files[0].content, "Привіт\n");
  writeFileSync(join(root, "a.txt"), "Changed\n");
  assert.notEqual(snapshot(root, ["a.txt"]).id, s.id);
  assert.throws(() => snapshot(root, ["../outside"]), /disallowed/);
  assert.throws(() => snapshot(root, [".env"]), /disallowed/);
  symlinkSync(join(root, "a.txt"), join(root, "link"));
  assert.throws(() => snapshot(root, ["link"]), /symlink/);
  writeFileSync(join(root, "binary"), Buffer.from([0, 1]));
  assert.throws(() => snapshot(root, ["binary"]), /binary/);
  writeFileSync(join(root, "large"), "x".repeat(128 * 1024 + 1));
  assert.throws(() => snapshot(root, ["large"]), /too_large/);
});
test("review coverage and stale snapshot cannot be mistaken for approval", async (t) => {
  const { b, root } = fixture(t);
  writeFileSync(join(root, "a.js"), "export const a = 1;\n");
  const r = await b.call("codex", "request_review", {
    ...request,
    scope: "a.js only",
    files: ["a.js"],
  });
  const lease = await ready(b);
  const a = await accept(b, r.task_id, lease);
  const result = {
    kind: "review",
    scope: "a.js",
    examined_files: ["a.js"],
    skipped_files: [],
    findings: [],
    verdict: "no_findings",
    limitations: ["No tests run."],
  };
  await assert.rejects(
    b.call("claude", "submit_result", {
      ...a,
      result: { ...result, examined_files: [] },
    }),
    /coverage/,
  );
  await b.call("claude", "submit_result", { ...a, result });
  assert.equal(
    (await b.call("codex", "check_snapshot", { task_id: r.task_id })).matches,
    true,
  );
  writeFileSync(join(root, "a.js"), "export const a = 2;\n");
  assert.equal(
    (await b.call("codex", "check_snapshot", { task_id: r.task_id })).matches,
    false,
  );
});
test("tracked base, untracked and deletion snapshots keep exact bytes", (t) => {
  const { root } = fixture(t);
  execFileSync("git", ["init", "-q", root]);
  writeFileSync(join(root, "old.txt"), "old\n");
  execFileSync("git", ["-C", root, "add", "old.txt"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  rmSync(join(root, "old.txt"));
  writeFileSync(join(root, "new.txt"), "new\n");
  const s = snapshot(root, ["old.txt", "new.txt"]);
  assert.equal(s.files.find((f) => f.path === "old.txt").baseContent, "old\n");
  assert.equal(s.files.find((f) => f.path === "old.txt").status, "deleted");
  assert.equal(s.files.find((f) => f.path === "new.txt").status, "added");
});
test("real STDIO adapters and Unix IPC round trip (synthetic host, not native Claude)", async (t) => {
  const { root, c } = fixture(t);
  const broker = await startBroker(c);
  t.after(() => broker.stop());
  const codex = new Client({ name: "codex-test", version: "1.0" });
  const claude = new Client({ name: "claude-synthetic-test", version: "1.0" });
  const notifications = [];
  claude.setNotificationHandler(
    z.object({
      method: z.literal("notifications/claude/channel"),
      params: z.any(),
    }),
    (n) => notifications.push(n.params),
  );
  const a = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp", "codex", "--project", root],
    stderr: "pipe",
  });
  const b = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp", "claude", "--project", root],
    stderr: "pipe",
  });
  t.after(async () => {
    await codex.close();
    await claude.close();
  });
  await codex.connect(a);
  await claude.connect(b);
  const wait = async (count) => {
    const until = Date.now() + 6000;
    while (notifications.length < count && Date.now() < until)
      await new Promise((r) => setTimeout(r, 25));
    assert.ok(notifications.length >= count);
  };
  await wait(1);
  assert.deepEqual(
    claude.getServerCapabilities().experimental["claude/channel"],
    {},
  );
  const tools = await claude.listTools();
  const codexTools = (await codex.listTools()).tools;
  assert.ok(codexTools.some((t) => t.name === "acknowledge_callback"));
  assert.ok(
    !codexTools.some((t) =>
      ["configure_callback", "resolve_stopped_task"].includes(t.name),
    ),
  );
  assert.ok(
    codexTools.find((t) => t.name === "request_architecture").inputSchema
      .properties.notify_on_completion,
  );
  assert.ok(tools.tools.some((t) => t.name === "submit_result"));
  assert.ok(
    !tools.tools.find((t) => t.name === "accept_task").inputSchema.properties
      .lease,
  );
  const decode = (r) => {
    assert.ok(!r.isError, JSON.stringify(r));
    return JSON.parse(r.content[0].text);
  };
  decode(
    await claude.callTool({
      name: "channel_ready",
      arguments: { nonce: notifications[0].meta.nonce },
    }),
  );
  const r = decode(
    await codex.callTool({ name: "request_architecture", arguments: request }),
  );
  await wait(2);
  assert.equal(notifications[1].meta.task_id, r.task_id);
  assert.ok(
    Object.values(notifications[1].meta).every((v) => typeof v === "string"),
  );
  const args = { task_id: r.task_id, snapshot_id: r.snapshot_id };
  decode(await claude.callTool({ name: "accept_task", arguments: args }));
  const context = decode(
    await claude.callTool({ name: "task_context", arguments: args }),
  );
  assert.match(context.content, /Architecture fixture/);
  decode(
    await claude.callTool({
      name: "submit_result",
      arguments: { ...args, result: architecture },
    }),
  );
  assert.deepEqual(
    decode(
      await codex.callTool({
        name: "task_result",
        arguments: { task_id: r.task_id },
      }),
    ).result,
    architecture,
  );
  await assert.rejects(
    rpc({ ...c, codexSecret: "bad" }, "codex", "bridge_status", {}),
    /pairing_rejected/,
  );
  await assert.rejects(
    rpc({ ...c, bridgeSession: randomUUID() }, "codex", "bridge_status", {}),
    /binding_mismatch/,
  );
  await assert.rejects(
    rpc(c, "codex", "register", { lease: "invalid" }),
    /role_forbidden/,
  );
});
