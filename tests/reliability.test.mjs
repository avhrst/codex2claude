import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { Broker, startBroker } from "../dist/broker.js";
import { initConfig, loadConfig, publicBinding } from "../dist/config.js";
const request = {
  idempotency_key: "reliability",
  goal: "Bounded snapshot",
  files: [],
};
function fixture(t) {
  const root = mkdtempSync("/private/tmp/c2c-reliable-");
  const c = initConfig(root);
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(c.socket, ".."), { recursive: true, force: true });
  });
  return { root, c, b: new Broker(c) };
}
async function ready(b, lease = "lease") {
  await b.call("claude", "register", { lease });
  const e = (await b.call("claude", "poll", { lease })).event;
  await b.call("claude", "channel_ready", { lease, nonce: e.nonce });
  return lease;
}
test("private state, persisted receipts, corruption and symlink store rejection", async (t) => {
  const { c, b, root } = fixture(t);
  assert.equal(statSync(c.stateDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(c.stateDir, "config.json")).mode & 0o777, 0o600);
  await b.call("codex", "request_architecture", request);
  assert.equal(statSync(join(c.stateDir, "tasks.json")).mode & 0o777, 0o600);
  const data = JSON.parse(readFileSync(join(c.stateDir, "tasks.json"), "utf8"));
  Object.values(data.tasks)[0].snapshot.id = "wrong";
  writeFileSync(join(c.stateDir, "tasks.json"), JSON.stringify(data));
  assert.throws(() => new Broker(c), /integrity_error/);
  rmSync(join(c.stateDir, "tasks.json"));
  writeFileSync(join(root, "outside.json"), "{}");
  symlinkSync(join(root, "outside.json"), join(c.stateDir, "tasks.json"));
  assert.throws(() => new Broker(c), /unsafe_store_file/);
  rmSync(join(c.stateDir, "tasks.json"));
  symlinkSync(join(root, "missing-store.json"), join(c.stateDir, "tasks.json"));
  assert.throws(() => new Broker(c), /unsafe_store_file/);
});
test("cancellation notification also works before acceptance and after deadline", async (t) => {
  const { b } = fixture(t);
  const lease = await ready(b);
  const r = await b.call("codex", "request_architecture", request);
  const event = (await b.call("claude", "poll", { lease })).event;
  b.written(r.task_id, lease);
  b.task(r.task_id).deadline = Date.now() - 1;
  // Expired unaccepted task cannot be executed.
  await assert.rejects(
    b.call("claude", "accept_task", {
      lease,
      task_id: r.task_id,
      snapshot_id: event.snapshot_id,
    }),
    /not_accepting/,
  );
  const b2 = fixture(t).b;
  const l2 = await ready(b2);
  const r2 = await b2.call("codex", "request_architecture", request);
  const e2 = (await b2.call("claude", "poll", { lease: l2 })).event;
  await b2.call("codex", "cancel_task", {
    task_id: r2.task_id,
    reason: "Stop before accept",
  });
  assert.equal(
    (await b2.call("claude", "poll", { lease: l2 })).event.kind,
    "cancel",
  );
  await b2.call("claude", "acknowledge_cancel", {
    lease: l2,
    task_id: r2.task_id,
    snapshot_id: e2.snapshot_id,
  });
  assert.equal(
    (await b2.call("codex", "task_status", { task_id: r2.task_id })).state,
    "cancelled",
  );
});
test("expired accepted execution retains slot and cooperative cancellation is still delivered", async (t) => {
  const { b } = fixture(t);
  const lease = await ready(b);
  const r = await b.call("codex", "request_architecture", request);
  const e = (await b.call("claude", "poll", { lease })).event;
  const a = { lease, task_id: r.task_id, snapshot_id: e.snapshot_id };
  await b.call("claude", "accept_task", a);
  b.task(r.task_id).deadline = Date.now() - 1;
  await assert.rejects(
    b.call("codex", "request_architecture", {
      ...request,
      idempotency_key: "second",
    }),
    /participant_busy/,
  );
  await b.call("codex", "cancel_task", {
    task_id: r.task_id,
    reason: "Expired native turn must stop",
  });
  assert.equal(
    (await b.call("claude", "poll", { lease })).event.kind,
    "cancel",
  );
  await b.call("claude", "acknowledge_cancel", a);
  assert.equal(
    (await b.call("codex", "task_status", { task_id: r.task_id })).state,
    "cancelled",
  );
});
test("UTF-8 IPC survives a multibyte character split across socket chunks", async (t) => {
  const { c } = fixture(t);
  const { stop } = await startBroker(c);
  t.after(stop);
  const req = {
    role: "codex",
    secret: c.codexSecret,
    binding: publicBinding(c),
    op: "request_architecture",
    args: { ...request, goal: "Привіт" },
  };
  const frame = Buffer.from(JSON.stringify(req) + "\n");
  const split = frame.indexOf(Buffer.from("П")) + 1;
  const response = await new Promise((resolve, reject) => {
    const s = net.createConnection(c.socket);
    let out = "";
    s.on("error", reject);
    s.on("connect", () => {
      s.write(frame.subarray(0, split));
      setTimeout(() => s.write(frame.subarray(split)), 20);
    });
    s.on("data", (b) => (out += b.toString()));
    s.on("end", () => resolve(JSON.parse(out)));
  });
  assert.equal(response.ok, true);
  const persisted = JSON.parse(
    readFileSync(join(c.stateDir, "tasks.json"), "utf8"),
  );
  assert.equal(Object.values(persisted.tasks)[0].request.goal, "Привіт");
});
test("bounded wait times out and context stays immutable in pages", async (t) => {
  const { b, root } = fixture(t);
  writeFileSync(join(root, "large.txt"), "a".repeat(20000));
  const r = await b.call("codex", "request_architecture", {
    ...request,
    files: ["large.txt"],
  });
  const before = Date.now();
  assert.equal(
    (
      await b.call("codex", "wait_for_task", {
        task_id: r.task_id,
        timeout_seconds: 0.1,
      })
    ).timed_out,
    true,
  );
  assert.ok(Date.now() - before < 1500);
  const lease = await ready(b);
  const e = (await b.call("claude", "poll", { lease })).event;
  const a = { lease, task_id: r.task_id, snapshot_id: e.snapshot_id };
  await b.call("claude", "accept_task", a);
  writeFileSync(join(root, "large.txt"), "new bytes");
  let offset = 0,
    content = "";
  do {
    const page = await b.call("claude", "task_context", {
      ...a,
      offset,
      limit: 1000,
    });
    content += page.content;
    offset = page.next_offset;
  } while (offset !== null);
  assert.equal(
    JSON.parse(content).snapshot.files[0].content,
    "a".repeat(20000),
  );
  assert.equal(
    (await b.call("codex", "check_snapshot", { task_id: r.task_id })).matches,
    false,
  );
});

test("offline accepted task keeps its lease and progress through recovery", async (t) => {
  const { b, c } = fixture(t);
  const lease = await ready(b);
  const r = await b.call("codex", "request_architecture", request);
  const e = (await b.call("claude", "poll", { lease })).event;
  const a = { lease, task_id: r.task_id, snapshot_id: e.snapshot_id };
  await b.call("claude", "accept_task", a);
  await b.call("claude", "report_progress", {
    ...a,
    message: "Reviewing the captured contract",
  });
  b.participant.lastHeartbeat = Date.now() - 10001;
  const status = await b.call("codex", "task_status", { task_id: r.task_id });
  assert.equal(status.state, "needs_human");
  assert.equal(status.progress.message, "Reviewing the captured contract");
  assert.match(status.human_action, /heartbeat expired/);
  await assert.rejects(
    b.call("codex", "request_architecture", {
      ...request,
      idempotency_key: "no-replay",
    }),
    /participant_busy/,
  );
  const recovered = new Broker(c);
  assert.equal(
    recovered.task(r.task_id).progress.message,
    status.progress.message,
  );
  await ready(recovered, "replacement");
  await assert.rejects(
    recovered.call("claude", "accept_task", { ...a, lease: "replacement" }),
    /acceptance_lease_conflict/,
  );
  // A reconnecting adapter with the original lease may finish existing work,
  // but duplicate acceptance must never start a second execution.
  await b.call("claude", "register", { lease });
  assert.equal((await b.call("claude", "accept_task", a)).execute, false);
  await b.call("claude", "report_progress", {
    ...a,
    message: "Connection restored",
  });
  assert.equal(b.task(r.task_id).state, "running");
});

test("offline unaccepted notification needs reconciliation and is never replayed", async (t) => {
  const { b } = fixture(t);
  const lease = await ready(b);
  const r = await b.call("codex", "request_architecture", request);
  await b.call("claude", "poll", { lease });
  b.written(r.task_id, lease);
  b.participant.lastHeartbeat = Date.now() - 10001;
  assert.equal(
    (await b.call("codex", "task_status", { task_id: r.task_id })).state,
    "delivery_uncertain",
  );
  await b.call("claude", "register", { lease });
  assert.equal((await b.call("claude", "poll", { lease })).event, null);
  assert.equal(b.task(r.task_id).deliveryAttempts, 1);
});

test("cancellation cannot shift context pages and stop acknowledgement is idempotent", async (t) => {
  const { b, c, root } = fixture(t);
  writeFileSync(join(root, "pages.txt"), "ю".repeat(12000));
  const lease = await ready(b);
  const r = await b.call("codex", "request_architecture", {
    ...request,
    files: ["pages.txt"],
  });
  const e = (await b.call("claude", "poll", { lease })).event;
  const a = { lease, task_id: r.task_id, snapshot_id: e.snapshot_id };
  await b.call("claude", "accept_task", a);
  const first = await b.call("claude", "task_context", { ...a, limit: 500 });
  await b.call("codex", "cancel_task", {
    task_id: r.task_id,
    reason: "Stop now",
  });
  let content = first.content;
  let offset = first.next_offset;
  while (offset !== null) {
    const page = await b.call("claude", "task_context", {
      ...a,
      offset,
      limit: 500,
    });
    assert.equal(page.total_chars, first.total_chars);
    assert.equal(page.cancel_request.reason, "Stop now");
    assert.equal(page.state, "cancel_requested");
    content += page.content;
    offset = page.next_offset;
  }
  assert.equal(
    JSON.parse(content).snapshot.files[0].content,
    "ю".repeat(12000),
  );
  assert.equal("cancel_request" in JSON.parse(content), false);
  assert.equal(
    (await b.call("claude", "poll", { lease })).event.kind,
    "cancel",
  );
  const restarted = new Broker(c);
  await ready(restarted, lease);
  assert.equal(
    (await restarted.call("claude", "poll", { lease })).event.kind,
    "cancel",
  );
  const stopped = await restarted.call("claude", "acknowledge_cancel", a);
  const events = stopped.events.length;
  assert.equal(
    (await restarted.call("claude", "acknowledge_cancel", a)).events.length,
    events,
  );
  assert.equal(restarted.task(r.task_id).state, "cancelled");
});

test("persisted request and result corruption is rejected before readiness", async (t) => {
  const { b, c } = fixture(t);
  const r = await b.call("codex", "request_architecture", request);
  const lease = await ready(b);
  const e = (await b.call("claude", "poll", { lease })).event;
  await b.call("claude", "accept_task", {
    lease,
    task_id: r.task_id,
    snapshot_id: e.snapshot_id,
  });
  await b.call("claude", "submit_result", {
    lease,
    task_id: r.task_id,
    snapshot_id: e.snapshot_id,
    result: {
      kind: "architecture",
      architecture: "A local broker",
      alternatives: [],
      contracts: [],
      implementation: [],
      risks: [],
      verification: [],
      clarifications: [],
    },
  });
  const path = join(c.stateDir, "tasks.json");
  const original = readFileSync(path, "utf8");
  const corruptions = [
    (task) => {
      task.request.goal = "Changed after acceptance";
    },
    (task) => {
      task.result.payload.architecture = "Changed result";
    },
    (task) => {
      task.result.payload.architecture = 123;
    },
    (task) => {
      task.acceptance.snapshotId = "another";
    },
    (task) => {
      task.result.late = true;
    },
    (task) => {
      task.id = "wrong-key";
    },
  ];
  for (const corrupt of corruptions) {
    const data = JSON.parse(original);
    corrupt(data.tasks[r.task_id]);
    writeFileSync(path, JSON.stringify(data));
    assert.throws(() => new Broker(c), /store_integrity_error/);
  }
  writeFileSync(path, original);
  assert.equal(new Broker(c).task(r.task_id).state, "completed");
});

test("operator reconciliation requires exact stopped lease and never fabricates completion", async (t) => {
  const { b, c } = fixture(t);
  const lease = await ready(b);
  const r = await b.call("codex", "request_architecture", request);
  const e = (await b.call("claude", "poll", { lease })).event;
  const a = { lease, task_id: r.task_id, snapshot_id: e.snapshot_id };
  await b.call("claude", "accept_task", a);
  await b.call("claude", "report_blocked", {
    ...a,
    message: "Native session lost",
  });
  await b.call("codex", "cancel_task", {
    task_id: r.task_id,
    reason: "Stop the lost accepted task",
  });
  const args = {
    task_id: r.task_id,
    lease,
    confirm_native_stopped: true,
    reason: "I closed the native session",
  };
  await assert.rejects(
    b.call("claude", "resolve_stopped_task", args),
    /role_forbidden/,
  );
  await assert.rejects(
    b.call("codex", "resolve_stopped_task", {
      ...args,
      confirm_native_stopped: false,
    }),
  );
  await assert.rejects(
    b.call("codex", "resolve_stopped_task", { ...args, lease: "other" }),
    /acceptance_lease_conflict/,
  );
  await assert.rejects(
    b.call("codex", "resolve_stopped_task", args),
    /native_adapter_still_connected/,
  );
  b.participant.lastHeartbeat = Date.now() - 10001;
  const stopped = await b.call("codex", "resolve_stopped_task", args);
  assert.equal(stopped.state, "failed");
  assert.equal(stopped.result_receipt, undefined);
  const count = stopped.events.length;
  assert.equal(
    (await b.call("codex", "resolve_stopped_task", args)).events.length,
    count,
  );
  const restarted = new Broker(c);
  assert.equal(restarted.task(r.task_id).operatorStopped.lease, lease);
  const next = await restarted.call("codex", "request_architecture", {
    ...request,
    idempotency_key: "after-human-reconciliation",
  });
  assert.equal(next.state, "queued");
  await ready(restarted, lease);
  assert.equal(
    (await restarted.call("claude", "accept_task", a)).execute,
    false,
  );
  const late = await restarted.call("claude", "submit_result", {
    ...a,
    result: {
      kind: "architecture",
      architecture: "Late result",
      alternatives: [],
      contracts: [],
      implementation: [],
      risks: [],
      verification: [],
      clarifications: [],
    },
  });
  assert.equal(late.state, "failed");
  assert.equal(late.result_receipt.late, true);
  const payload = await restarted.call("codex", "task_result", {
    task_id: r.task_id,
  });
  assert.equal(payload.result, null);
  assert.equal(payload.late_result.architecture, "Late result");
  const waited = await restarted.call("codex", "wait_for_task", {
    task_id: r.task_id,
    timeout_seconds: 0,
  });
  assert.equal(waited.result, null);
  assert.equal(waited.late_result.architecture, "Late result");
  assert.equal(
    (await restarted.call("claude", "acknowledge_cancel", a)).state,
    "failed",
  );
  assert.equal(new Broker(c).task(r.task_id).state, "failed");
  assert.equal(
    (await restarted.call("claude", "poll", { lease })).event.task_id,
    next.task_id,
  );
});
