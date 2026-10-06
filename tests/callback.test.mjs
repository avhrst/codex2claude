import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Broker, startBroker } from "../dist/broker.js";
import { initConfig } from "../dist/config.js";
import { queueCallback } from "../dist/callback.js";
import { requestSchema, digest } from "../dist/protocol.js";

const threadId = randomUUID();
const route = { threadId, codexBin: process.execPath };
const request = {
  idempotency_key: "callback",
  goal: "PRIVATE_GOAL",
  files: [],
};
const architecture = {
  kind: "architecture",
  architecture: "PRIVATE_RESULT",
  alternatives: [],
  contracts: [],
  implementation: [],
  risks: [],
  verification: [],
  clarifications: [],
};
function fixture(t) {
  const root = mkdtempSync("/private/tmp/c2c-callback-");
  const c = initConfig(root);
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(c.socket, ".."), { recursive: true, force: true });
  });
  return { root, c, b: new Broker(c) };
}
async function completed(b, optIn = true, late = false) {
  if (optIn)
    await b.call("codex", "configure_callback", { mode: "enable", route });
  const r = await b.call("codex", "request_architecture", {
    ...request,
    ...(optIn
      ? { originating_chat: threadId, notify_on_completion: true }
      : {}),
  });
  await b.call("claude", "register", { lease: "fixture" });
  const hello = (await b.call("claude", "poll", { lease: "fixture" })).event;
  await b.call("claude", "channel_ready", {
    lease: "fixture",
    nonce: hello.nonce,
  });
  await b.call("claude", "poll", { lease: "fixture" });
  const a = {
    task_id: r.task_id,
    snapshot_id: r.snapshot_id,
    lease: "fixture",
  };
  await b.call("claude", "accept_task", a);
  if (late) b.task(r.task_id).deadline = Date.now() - 1;
  await b.call("claude", "submit_result", { ...a, result: architecture });
  return b.task(r.task_id);
}
test("callback requires explicit route and per-task opt-in; old request hashes and late results are preserved", async (t) => {
  const { b } = fixture(t);
  assert.equal(
    Object.hasOwn(requestSchema.parse(request), "notify_on_completion"),
    false,
  );
  const parsed = requestSchema.parse(request);
  assert.equal(
    digest(parsed),
    digest({ ...parsed, notify_on_completion: undefined }),
  );
  await assert.rejects(
    b.call("codex", "request_architecture", {
      ...request,
      originating_chat: threadId,
      notify_on_completion: true,
    }),
    /callback_route_not_enabled/,
  );
  await assert.rejects(
    b.call("claude", "configure_callback", { mode: "enable", route }),
    /role_forbidden/,
  );
  await b.call("codex", "configure_callback", { mode: "enable", route });
  await assert.rejects(
    b.call("codex", "request_architecture", {
      ...request,
      originating_chat: randomUUID(),
      notify_on_completion: true,
    }),
    /callback_route_not_enabled/,
  );
  const plain = await completed(b, false);
  assert.equal(plain.callback, undefined);
  assert.equal(plain.callbackRoute, undefined);
  const late = await completed(fixture(t).b, true, true);
  assert.equal(late.result.late, true);
  assert.equal(late.callback, undefined);
});
test("durable sending precedes CLI effect; queued differs from delivered and exact acknowledgment survives restart", async (t) => {
  const { b, c, root } = fixture(t);
  const task = await completed(b);
  let ack;
  await assert.rejects(
    b.call("codex", "acknowledge_callback", {
      task_id: task.id,
      snapshot_id: task.snapshot.id,
      thread_id: threadId,
      result_digest: task.result.digest,
      nonce: randomUUID(),
    }),
    /callback_correlation_mismatch/,
  );
  const messageId = randomUUID();
  await b.dispatchCallbacks(async (target, message, cwd) => {
    const persisted = JSON.parse(
      readFileSync(join(c.stateDir, "tasks.json"), "utf8"),
    );
    assert.equal(persisted.tasks[task.id].callback.state, "sending");
    assert.deepEqual(target, route);
    assert.equal(cwd, root);
    assert.ok(!message.includes("PRIVATE_GOAL"));
    assert.ok(!message.includes("PRIVATE_RESULT"));
    ack = JSON.parse(message.split("\n").at(-1)).acknowledgment;
    assert.equal(
      persisted.tasks[task.id].callback.nonceDigest,
      digest(ack.nonce),
    );
    assert.ok(
      !readFileSync(join(c.stateDir, "tasks.json"), "utf8").includes(ack.nonce),
    );
    return messageId;
  });
  assert.equal(task.callback.state, "queued");
  assert.equal(task.callback.messageId, messageId);
  for (const op of ["task_status", "task_result", "wait_for_task"]) {
    const r = await b.call("codex", op, {
      task_id: task.id,
      ...(op === "wait_for_task" ? { timeout_seconds: 0 } : {}),
    });
    assert.ok(!JSON.stringify(r).includes(ack.nonce));
    assert.equal(Object.hasOwn(r.callback, "nonce"), false);
    assert.equal(Object.hasOwn(r.callback, "nonceDigest"), false);
  }
  const restarted = new Broker(c);
  let sends = 0;
  await restarted.dispatchCallbacks(async () => {
    sends++;
  });
  assert.equal(sends, 0);
  for (const field of [
    "task_id",
    "snapshot_id",
    "thread_id",
    "result_digest",
    "nonce",
  ]) {
    const wrong = {
      ...ack,
      [field]: field === "result_digest" ? "0".repeat(64) : randomUUID(),
    };
    await assert.rejects(
      restarted.call("codex", "acknowledge_callback", wrong),
    );
  }
  await assert.rejects(
    restarted.call("claude", "acknowledge_callback", ack),
    /role_forbidden/,
  );
  const receipt = await restarted.call("codex", "acknowledge_callback", ack);
  assert.equal(receipt.callback.state, "delivered");
  const at = receipt.callback.deliveredAt;
  assert.equal(
    (await restarted.call("codex", "acknowledge_callback", ack)).callback
      .deliveredAt,
    at,
  );
  assert.equal(new Broker(c).task(task.id).callback.state, "delivered");
});
test("restart or CLI failure never repeats ambiguous callback; actual incoming nonce can reconcile it", async (t) => {
  const { b, c } = fixture(t);
  const task = await completed(b);
  let ack;
  await b.dispatchCallbacks(async (_route, message) => {
    ack = JSON.parse(message.split("\n").at(-1)).acknowledgment;
    const restarted = new Broker(c);
    assert.equal(restarted.task(task.id).callback.state, "uncertain");
    let sends = 0;
    await restarted.dispatchCallbacks(async () => {
      sends++;
    });
    assert.equal(sends, 0);
    throw new Error("unknown queue outcome with private stderr");
  });
  assert.equal(task.callback.state, "uncertain");
  let sends = 0;
  await b.dispatchCallbacks(async () => {
    sends++;
  });
  assert.equal(sends, 0);
  const receipt = await b.call("codex", "acknowledge_callback", ack);
  assert.equal(receipt.callback.state, "delivered");
});
test("disable suppresses unsent callbacks; concurrent acknowledgment is never downgraded by queue completion", async (t) => {
  const { b } = fixture(t);
  const task = await completed(b);
  await b.call("codex", "configure_callback", { mode: "disable" });
  await b.dispatchCallbacks(async () => {
    assert.fail("disabled sender ran");
  });
  assert.equal(task.callback.state, "suppressed");
  const b2 = fixture(t).b,
    t2 = await completed(b2);
  let finish;
  let ack;
  const flight = b2.dispatchCallbacks(
    (_route, message) =>
      new Promise((resolve) => {
        ack = JSON.parse(message.split("\n").at(-1)).acknowledgment;
        finish = resolve;
      }),
  );
  assert.equal(b2.dispatchCallbacks(), flight);
  await assert.rejects(
    b2.call("codex", "configure_callback", { mode: "disable" }),
    /callback_in_flight/,
  );
  await b2.call("codex", "acknowledge_callback", ack);
  finish(randomUUID());
  await flight;
  assert.equal(t2.callback.state, "delivered");
  assert.ok(t2.callback.messageId);
});
test("CLI uses literal argv and accepts only exact addressed receipt; malformed/failing output stays uncertain", async (t) => {
  const { root } = fixture(t);
  const bin = join(root, "fake codex $(no-shell)");
  const log = join(root, "argv.json");
  const messageId = randomUUID(),
    message = "literal `shell` $(data)\nmessage";
  const source = `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));`;
  const script = (output) => {
    writeFileSync(bin, source + output);
    chmodSync(bin, 0o700);
  };
  script(
    `console.log(${JSON.stringify(`Queued message ${messageId} for thread ${threadId}.`)});`,
  );
  assert.equal(
    await queueCallback({ threadId, codexBin: bin }, message, root),
    messageId,
  );
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), [
    "queue",
    "--thread",
    threadId,
    "--message",
    message,
  ]);
  for (const output of [
    `console.log('Queued message ${messageId} for thread ${randomUUID()}.');`,
    "console.log('unrecognized receipt');",
    "console.error('PRIVATE_AUTH_TEXT');process.exit(1);",
    "console.log('x'.repeat(20000));",
  ]) {
    script(output);
    await assert.rejects(
      queueCallback({ threadId, codexBin: bin }, message, root),
      /^Error: callback_queue_uncertain$/,
    );
  }
});
test("callback correlation/store corruption is rejected before dispatch", async (t) => {
  const { b, c } = fixture(t);
  const task = await completed(b);
  const file = join(c.stateDir, "tasks.json"),
    original = readFileSync(file, "utf8");
  for (const corrupt of [
    (t) => {
      t.callback.resultDigest = "0".repeat(64);
    },
    (t) => {
      t.callbackRoute.threadId = randomUUID();
    },
    (t) => {
      t.callback.nonceDigest = "invalid";
    },
    (t) => {
      t.callback.state = "delivered";
    },
    (t) => {
      t.callback.state = "queued";
    },
  ]) {
    const data = JSON.parse(original);
    corrupt(data.tasks[task.id]);
    writeFileSync(file, JSON.stringify(data));
    assert.throws(() => new Broker(c), /store_integrity_error/);
  }
  writeFileSync(file, original);
});

test("persistence failure before send is a rejected promise and can retry storage without external replay", async (t) => {
  const { b } = fixture(t);
  const task = await completed(b);
  const save = b.save.bind(b);
  b.save = () => {
    throw new Error("disk_full");
  };
  let sends = 0;
  await assert.rejects(
    b.dispatchCallbacks(async () => {
      sends++;
    }),
    /callback_store_failed/,
  );
  assert.equal(task.callback.state, "pending");
  assert.equal(task.callback.nonceDigest, undefined);
  assert.equal(sends, 0);
  assert.equal(b.callbackFlight, undefined);
  b.save = save;
  await b.dispatchCallbacks(async () => {
    sends++;
    return randomUUID();
  });
  assert.equal(sends, 1);
  assert.equal(task.callback.state, "queued");
});

test("initial exposed alpha nonce migrates to hash without replay and cannot become delivery proof", async (t) => {
  const { b, c } = fixture(t);
  const task = await completed(b);
  let ack;
  await b.dispatchCallbacks(async (_route, message) => {
    ack = JSON.parse(message.split("\n").at(-1)).acknowledgment;
    return randomUUID();
  });
  const file = join(c.stateDir, "tasks.json"),
    data = JSON.parse(readFileSync(file, "utf8"));
  data.tasks[task.id].callback.nonce = ack.nonce;
  delete data.tasks[task.id].callback.nonceDigest;
  writeFileSync(file, JSON.stringify(data));
  const restarted = new Broker(c);
  assert.ok(!readFileSync(file, "utf8").includes(ack.nonce));
  assert.equal(restarted.task(task.id).callback.nonceDigest, digest(ack.nonce));
  await restarted.dispatchCallbacks(async () => {
    assert.fail("migration replayed");
  });
  assert.equal(restarted.task(task.id).callback.legacyNonceExposed, true);
  await assert.rejects(
    restarted.call("codex", "acknowledge_callback", ack),
    /legacy_callback_requires_manual_resume/,
  );
});

test("broker shutdown removes socket and lock even when in-flight final persistence fails", async (t) => {
  const { c } = fixture(t);
  const { broker, stop } = await startBroker(c);
  t.after(stop);
  await completed(broker);
  let finish, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const flight = broker.dispatchCallbacks(
    () =>
      new Promise((resolve) => {
        finish = resolve;
        entered();
      }),
  );
  await started;
  broker.save = () => {
    throw new Error("disk_full");
  };
  const rejected = assert.rejects(flight, /disk_full/);
  const stopped = stop();
  finish(randomUUID());
  await rejected;
  await stopped;
  assert.equal(existsSync(c.socket), false);
  assert.equal(existsSync(join(c.stateDir, "broker.lock")), false);
  const restarted = new Broker(c);
  assert.equal(Object.values(restarted.tasks)[0].callback.state, "uncertain");
});
