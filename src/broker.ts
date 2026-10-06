import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  openSync,
  closeSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { join } from "node:path";
import { z } from "zod";
import { type Config, publicBinding } from "./config.js";
import {
  canonical,
  correlationSchema,
  digest,
  fail,
  id,
  requestSchema,
  resultSchema,
  terminal,
  text,
  type Participant,
  type State,
  type Task,
} from "./protocol.js";
import { atomicJson, readJson } from "./storage.js";
import { snapshot } from "./snapshot.js";

export const MAX_FRAME = 4 * 1024 * 1024;
const now = () => new Date().toISOString();
const bindingArgs = correlationSchema.extend({ lease: id });
export const schemas = {
  request_architecture: requestSchema,
  request_review: requestSchema.extend({
    scope: text,
    base: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_/.~-]+$/)
      .optional(),
    files: z.array(z.string().min(1).max(512)).min(1).max(100),
  }),
  task_status: z.object({ task_id: id }).strict(),
  task_result: z.object({ task_id: id }).strict(),
  wait_for_task: z
    .object({
      task_id: id,
      timeout_seconds: z.number().min(0).max(25).default(20),
    })
    .strict(),
  cancel_task: z.object({ task_id: id, reason: text }).strict(),
  reconcile_delivery: z
    .object({ task_id: id, decision: z.enum(["retry", "cancel"]) })
    .strict(),
  resolve_stopped_task: z
    .object({
      task_id: id,
      lease: id,
      confirm_native_stopped: z.literal(true),
      reason: text,
    })
    .strict(),
  check_snapshot: z.object({ task_id: id }).strict(),
  register: z.object({ lease: id }).strict(),
  poll: z.object({ lease: id }).strict(),
  channel_ready: z.object({ lease: id, nonce: id }).strict(),
  accept_task: bindingArgs,
  task_context: bindingArgs.extend({
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(16000).default(12000),
  }),
  report_progress: bindingArgs.extend({ message: text }),
  report_blocked: bindingArgs.extend({ message: text }),
  submit_result: bindingArgs.extend({ result: resultSchema }),
  acknowledge_cancel: bindingArgs,
  bridge_status: z.object({}).strict(),
} as const;
export type Op = keyof typeof schemas;
const codexOps = new Set<Op>([
  "request_architecture",
  "request_review",
  "task_status",
  "task_result",
  "wait_for_task",
  "cancel_task",
  "reconcile_delivery",
  "resolve_stopped_task",
  "check_snapshot",
  "bridge_status",
]);
const claudeOps = new Set<Op>([
  "register",
  "poll",
  "channel_ready",
  "accept_task",
  "task_context",
  "report_progress",
  "report_blocked",
  "submit_result",
  "acknowledge_cancel",
  "bridge_status",
]);
interface Store {
  version: 1;
  bindingHash: string;
  tasks: Record<string, Task>;
}
export class Broker {
  tasks: Record<string, Task>;
  participant?: Participant;
  handshakeSent = false;
  constructor(readonly config: Config) {
    const store = readJson<Store>(join(config.stateDir, "tasks.json"), {
      version: 1,
      bindingHash: digest(publicBinding(config)),
      tasks: {},
    });
    if (
      store.version !== 1 ||
      store.bindingHash !== digest(publicBinding(config))
    )
      fail("store_binding_mismatch");
    this.tasks = store.tasks;
    for (const [taskId, t] of Object.entries(this.tasks)) {
      if (
        digest(t.binding) !== store.bindingHash ||
        t.snapshot.id !==
          digest({
            files: t.snapshot.files,
            head: t.snapshot.head,
            base: t.snapshot.base,
            inclusion: t.snapshot.inclusion,
          })
      )
        fail("store_integrity_error");
      if (
        t.contractVersion !== 1 ||
        t.id !== taskId ||
        !["architecture", "review"].includes(t.kind) ||
        ![
          "queued",
          "notified",
          "accepted",
          "running",
          "completed",
          "needs_human",
          "failed",
          "expired",
          "delivery_uncertain",
          "cancel_requested",
          "cancelled",
        ].includes(t.state) ||
        !Number.isFinite(t.deadline) ||
        t.requestHash !== digest({ kind: t.kind, args: t.request }) ||
        (t.acceptance && t.acceptance.snapshotId !== t.snapshot.id) ||
        (t.operatorStopped &&
          (!t.acceptance ||
            t.operatorStopped.lease !== t.acceptance.lease ||
            t.state !== "failed")) ||
        (t.result &&
          (!t.acceptance ||
            !resultSchema.safeParse(t.result.payload).success ||
            t.result.digest !== digest(t.result.payload) ||
            t.result.payload.kind !== t.kind ||
            typeof t.result.late !== "boolean")) ||
        (t.state === "completed" && (!t.result || t.result.late))
      )
        fail("store_integrity_error");
      if (["notified", "delivery_uncertain"].includes(t.state))
        this.transition(
          t,
          "delivery_uncertain",
          "Broker restarted: reconcile delivery before retry.",
        );
      else if (["accepted", "running"].includes(t.state))
        this.transition(
          t,
          "needs_human",
          "Broker restarted: execution may still be active; no automatic replay.",
        );
      // Cancellation is safe to repeat; never lose a pending stop notification
      // when the same native adapter reconnects after a broker crash.
      if (t.state === "cancel_requested") delete t.cancelNotified;
    }
    this.save();
  }
  save() {
    atomicJson(join(this.config.stateDir, "tasks.json"), {
      version: 1,
      bindingHash: digest(publicBinding(this.config)),
      tasks: this.tasks,
    });
  }
  transition(t: Task, state: State, detail: string) {
    t.state = state;
    t.updatedAt = now();
    if (state === "needs_human" || state === "delivery_uncertain")
      t.humanAction = detail;
    else delete t.humanAction;
    t.events.push({ at: t.updatedAt, state, detail });
    if (t.events.length > 200) t.events.shift();
  }
  task(taskId: string) {
    return this.tasks[taskId] ?? fail("task_not_found");
  }
  receipt(t: Task) {
    return {
      task_id: t.id,
      snapshot_id: t.snapshot.id,
      state: t.state,
      binding: t.binding,
      created_at: t.createdAt,
      deadline: new Date(t.deadline).toISOString(),
      delivery_attempts: t.deliveryAttempts,
      delivery: t.delivery,
      acceptance: t.acceptance,
      result_receipt: t.result
        ? { at: t.result.at, digest: t.result.digest, late: t.result.late }
        : undefined,
      cancel_request: t.cancelRequest,
      progress: t.progress,
      operator_stopped: t.operatorStopped,
      human_action: ["needs_human", "delivery_uncertain"].includes(t.state)
        ? t.humanAction
        : undefined,
      events: t.events,
    };
  }
  result(t: Task) {
    return {
      ...this.receipt(t),
      result:
        t.state === "completed" && !t.result?.late
          ? (t.result?.payload ?? null)
          : null,
      late_result: t.result?.late ? t.result.payload : null,
    };
  }
  expire() {
    let changed = false;
    for (const t of Object.values(this.tasks))
      if (
        t.deadline < Date.now() &&
        !terminal.has(t.state) &&
        t.state !== "cancel_requested"
      ) {
        this.transition(
          t,
          "expired",
          "Deadline elapsed; late results retained separately.",
        );
        changed = true;
      }
    if (changed) this.save();
  }
  detectOffline() {
    if (
      !this.participant ||
      Date.now() - this.participant.lastHeartbeat <= 10000
    )
      return;
    let changed = false;
    for (const t of Object.values(this.tasks)) {
      if (terminal.has(t.state)) continue;
      if (
        ["accepted", "running"].includes(t.state) &&
        t.acceptance?.lease === this.participant.lease
      ) {
        this.transition(
          t,
          "needs_human",
          "Native adapter heartbeat expired; execution may still be active. Reconnect the same session or reconcile with the user; no automatic replay.",
        );
        changed = true;
      } else if (
        t.state === "notified" &&
        t.delivery?.lease === this.participant.lease
      ) {
        this.transition(
          t,
          "delivery_uncertain",
          "Native adapter disconnected before acceptance. Reconcile delivery before retry.",
        );
        changed = true;
      }
    }
    if (changed) this.save();
  }
  assertLease(lease: string) {
    if (!this.participant || this.participant.lease !== lease)
      fail("participant_lease_mismatch");
    if (Date.now() - this.participant.lastHeartbeat > 10000)
      fail("participant_offline");
  }
  active(taskId: string, snapshotId: string, lease: string) {
    this.assertLease(lease);
    const t = this.task(taskId);
    if (t.snapshot.id !== snapshotId) fail("snapshot_mismatch");
    if (!t.acceptance || t.acceptance.lease !== lease)
      fail("acceptance_required");
    return t;
  }
  async call(role: "codex" | "claude", op: Op, raw: unknown): Promise<unknown> {
    if (!(role === "codex" ? codexOps : claudeOps).has(op))
      fail("role_forbidden");
    const args = schemas[op].parse(raw) as Record<string, any>;
    this.expire();
    this.detectOffline();
    if (op === "bridge_status")
      return {
        binding: publicBinding(this.config),
        participant: this.participant
          ? {
              connected: Date.now() - this.participant.lastHeartbeat <= 10000,
              handshake: this.participant.handshake,
              lease: this.participant.lease,
            }
          : null,
        callback: "manual_resume_or_bounded_mcp_wait",
        tasks: Object.values(this.tasks).map((t) => ({
          task_id: t.id,
          state: t.state,
        })),
        ready:
          !!this.participant?.handshake &&
          Date.now() - this.participant.lastHeartbeat <= 10000,
      };
    if (op === "request_architecture" || op === "request_review") {
      const kind = op === "request_review" ? "review" : "architecture";
      const requestHash = digest({ kind, args });
      const prior = Object.values(this.tasks).find(
        (t) => t.request.idempotency_key === args.idempotency_key,
      );
      if (prior) {
        if (prior.requestHash !== requestHash) fail("idempotency_conflict");
        return this.receipt(prior);
      }
      if (args.parent_task_id) {
        const parent = this.task(args.parent_task_id);
        if (!terminal.has(parent.state)) fail("parent_not_terminal");
        let depth = 1,
          p = parent;
        while (p.request.parent_task_id) {
          p = this.task(p.request.parent_task_id);
          if (++depth >= 3) fail("review_cycle_limit");
        }
      }
      // Expiry does not prove that an accepted native turn has stopped.
      if (
        Object.values(this.tasks).some(
          (t) =>
            !terminal.has(t.state) ||
            (t.acceptance &&
              !t.result &&
              t.state !== "cancelled" &&
              !t.operatorStopped),
        )
      )
        fail("participant_busy");
      const snap = snapshot(this.config.root, args.files, args.base);
      const t: Task = {
        contractVersion: 1,
        id: randomUUID(),
        kind,
        binding: publicBinding(this.config),
        request: args as Task["request"],
        requestHash,
        snapshot: snap,
        state: "queued",
        createdAt: now(),
        updatedAt: now(),
        deadline: Date.now() + args.deadline_seconds * 1000,
        deliveryAttempts: 0,
        events: [],
      };
      this.transition(t, "queued", "Durable queue receipt only.");
      this.tasks[t.id] = t;
      this.save();
      return this.receipt(t);
    }
    if (op === "register") {
      if (
        this.participant &&
        this.participant.lease !== args.lease &&
        Date.now() - this.participant.lastHeartbeat <= 10000
      )
        fail("participant_already_connected");
      if (this.participant && this.participant.lease === args.lease) {
        this.participant.lastHeartbeat = Date.now();
        return { lease: args.lease };
      }
      this.participant = {
        lease: args.lease,
        lastHeartbeat: Date.now(),
        handshake: false,
        nonce: randomBytes(16).toString("hex"),
      };
      this.handshakeSent = false;
      return { lease: args.lease };
    }
    if (op === "poll") {
      this.assertLease(args.lease);
      const p = this.participant!;
      p.lastHeartbeat = Date.now();
      if (!p.handshake) {
        if (this.handshakeSent) return { event: null };
        this.handshakeSent = true;
        return { event: { kind: "handshake", nonce: p.nonce } };
      }
      const cancelled = Object.values(this.tasks).find(
        (t) =>
          t.cancelRequest &&
          t.state === "cancel_requested" &&
          t.cancelNotified !== args.lease &&
          (t.acceptance?.lease ?? t.delivery?.lease) === args.lease,
      );
      if (cancelled) {
        cancelled.cancelNotified = args.lease;
        this.save();
        return {
          event: {
            kind: "cancel",
            task_id: cancelled.id,
            snapshot_id: cancelled.snapshot.id,
          },
        };
      }
      const t = Object.values(this.tasks).find((t) => t.state === "queued");
      if (!t) return { event: null };
      t.delivery = { lease: args.lease, startedAt: now() };
      t.deliveryAttempts++;
      this.transition(
        t,
        "delivery_uncertain",
        "Delivery prepared; transport/Claude acknowledgment unknown.",
      );
      this.save();
      return {
        event: {
          kind: "task",
          task_id: t.id,
          snapshot_id: t.snapshot.id,
          task_kind: t.kind,
        },
      };
    }
    if (op === "channel_ready") {
      this.assertLease(args.lease);
      if (this.participant!.nonce !== args.nonce)
        fail("handshake_nonce_mismatch");
      this.participant!.handshake = true;
      return { ready: true, binding: publicBinding(this.config) };
    }
    if (op === "task_status") return this.receipt(this.task(args.task_id));
    if (op === "task_result") {
      const t = this.task(args.task_id);
      return this.result(t);
    }
    if (op === "wait_for_task") {
      const until = Date.now() + args.timeout_seconds * 1000;
      while (Date.now() < until) {
        const t = this.task(args.task_id);
        if (
          terminal.has(t.state) ||
          ["needs_human", "delivery_uncertain", "cancel_requested"].includes(
            t.state,
          )
        )
          break;
        await new Promise((r) => setTimeout(r, 200));
        this.expire();
        this.detectOffline();
      }
      const t = this.task(args.task_id);
      return {
        ...this.result(t),
        timed_out: !terminal.has(t.state),
      };
    }
    if (op === "check_snapshot") {
      const t = this.task(args.task_id);
      const current = snapshot(
        this.config.root,
        t.request.files,
        t.snapshot.base ?? undefined,
      );
      return {
        task_id: t.id,
        expected: t.snapshot.id,
        current: current.id,
        matches: current.id === t.snapshot.id,
      };
    }
    if (op === "reconcile_delivery") {
      const t = this.task(args.task_id);
      if (t.acceptance || !["delivery_uncertain", "notified"].includes(t.state))
        fail("reconcile_requires_unaccepted_delivery");
      if (args.decision === "retry") {
        if (t.deliveryAttempts >= 3) fail("delivery_attempt_limit");
        delete t.delivery;
        this.transition(
          t,
          "queued",
          "Operator explicitly reconciled and requested same-ID retry.",
        );
      } else {
        t.cancelRequest = {
          at: now(),
          reason: "Operator reconciled delivery and cancelled.",
        };
        this.transition(t, "cancelled", "Cancelled before acceptance.");
      }
      this.save();
      return this.receipt(t);
    }
    // Excluded from the MCP tool catalogs. Trusted same-user processes can
    // still invoke this CLI/RPC action; the flag does not authenticate a human.
    // Never invoke it autonomously based on a timeout or heartbeat alone.
    if (op === "resolve_stopped_task") {
      const t = this.task(args.task_id);
      if (!t.acceptance || t.acceptance.lease !== args.lease)
        fail("acceptance_lease_conflict");
      if (t.operatorStopped) return this.receipt(t);
      if (
        t.result ||
        !["needs_human", "expired", "cancel_requested"].includes(t.state)
      )
        fail("resolve_requires_unfinished_accepted_task");
      if (
        this.participant &&
        this.participant.lease === args.lease &&
        Date.now() - this.participant.lastHeartbeat <= 10000
      )
        fail("native_adapter_still_connected");
      t.operatorStopped = { at: now(), lease: args.lease, reason: args.reason };
      this.transition(
        t,
        "failed",
        "Operator attested the native session is stopped; task failed without replay or approval.",
      );
      this.save();
      return this.receipt(t);
    }
    if (op === "cancel_task") {
      const t = this.task(args.task_id);
      if (
        (!terminal.has(t.state) ||
          (t.acceptance && !t.result && t.state === "expired")) &&
        !t.cancelRequest
      ) {
        t.cancelRequest = { at: now(), reason: args.reason };
        this.transition(
          t,
          t.state === "queued" ? "cancelled" : "cancel_requested",
          "Cooperative cancellation requested; native turn may continue.",
        );
        this.save();
      }
      return this.receipt(t);
    }
    if (op === "accept_task") {
      this.assertLease(args.lease);
      const t = this.task(args.task_id);
      if (t.snapshot.id !== args.snapshot_id) fail("snapshot_mismatch");
      if (t.acceptance) {
        if (t.acceptance.lease !== args.lease)
          fail("acceptance_lease_conflict");
        return { ...this.receipt(t), already_accepted: true, execute: false };
      }
      if (
        t.cancelRequest ||
        t.deadline < Date.now() ||
        !["notified", "delivery_uncertain"].includes(t.state) ||
        t.delivery?.lease !== args.lease
      )
        fail("task_not_accepting");
      if (!this.participant!.handshake) fail("handshake_required");
      t.acceptance = {
        snapshotId: args.snapshot_id,
        lease: args.lease,
        at: now(),
      };
      this.transition(
        t,
        "accepted",
        "Claude explicitly accepted this snapshot.",
      );
      this.save();
      return { ...this.receipt(t), execute: true };
    }
    if (op === "acknowledge_cancel") {
      this.assertLease(args.lease);
      const t = this.task(args.task_id);
      if (t.snapshot.id !== args.snapshot_id) fail("snapshot_mismatch");
      if ((t.acceptance?.lease ?? t.delivery?.lease) !== args.lease)
        fail("cancel_lease_mismatch");
      if (!t.cancelRequest) fail("cancel_not_requested");
      if (t.state === "cancelled" || t.operatorStopped) return this.receipt(t);
      this.transition(
        t,
        "cancelled",
        "Claude acknowledged cooperative cancellation.",
      );
      this.save();
      return this.receipt(t);
    }
    const t = this.active(args.task_id, args.snapshot_id, args.lease);
    if (op === "task_context") {
      const ctx = canonical({
        task_id: t.id,
        kind: t.kind,
        binding: t.binding,
        request: t.request,
        snapshot: t.snapshot,
      });
      return {
        content: ctx.slice(args.offset, args.offset + args.limit),
        next_offset:
          args.offset + args.limit < ctx.length
            ? args.offset + args.limit
            : null,
        total_chars: ctx.length,
        cancel_request: t.cancelRequest,
        state: t.state,
      };
    }
    if (op === "submit_result") {
      const result = resultSchema.parse(args.result);
      if (result.kind !== t.kind) fail("result_kind_mismatch");
      if (result.kind === "review") {
        const scope = new Set(t.snapshot.files.map((f) => f.path));
        const examined = new Set(result.examined_files);
        const skipped = new Set(result.skipped_files.map((f) => f.path));
        if (
          examined.size !== result.examined_files.length ||
          skipped.size !== result.skipped_files.length ||
          [...examined, ...skipped].some((p) => !scope.has(p)) ||
          [...examined].some((p) => skipped.has(p)) ||
          examined.size + skipped.size !== scope.size
        )
          fail("invalid_review_coverage");
        if (result.findings.some((f) => !examined.has(f.file)))
          fail("finding_outside_examined_scope");
        if (
          result.verdict === "no_findings" &&
          (result.findings.length ||
            skipped.size ||
            examined.size !== scope.size)
        )
          fail("no_findings_requires_full_scope");
        if (result.findings.length && result.verdict === "no_findings")
          fail("verdict_conflict");
      }
      const hash = digest(result);
      if (t.result) {
        if (t.result.digest !== hash) fail("result_conflict");
        return this.receipt(t);
      }
      const late =
        t.deadline < Date.now() || !!t.cancelRequest || terminal.has(t.state);
      t.result = { payload: result, digest: hash, at: now(), late };
      if (!late)
        this.transition(
          t,
          "completed",
          "Claude submitted a correlated result.",
        );
      else
        t.events.push({
          at: now(),
          state: t.state,
          detail: "Late result retained; no timely completion claimed.",
        });
      this.save();
      return this.receipt(t);
    }
    if (terminal.has(t.state) || t.cancelRequest)
      fail("task_no_longer_running");
    if (op === "report_progress") {
      t.progress = { at: now(), message: args.message };
      this.transition(t, "running", "Claude reported progress.");
    }
    if (op === "report_blocked")
      this.transition(t, "needs_human", args.message);
    this.save();
    return this.receipt(t);
  }
  written(taskId: string, lease: string) {
    const t = this.task(taskId);
    if (t.delivery?.lease !== lease) fail("delivery_lease_mismatch");
    t.delivery.writtenAt = now();
    if (t.state === "delivery_uncertain" && !t.acceptance)
      this.transition(
        t,
        "notified",
        "Written to transport; native processing still unconfirmed.",
      );
    this.save();
  }
}

export async function startBroker(config: Config) {
  const lock = join(config.stateDir, "broker.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) fail("invalid_broker_lock");
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
    }
    if (alive) fail("broker_already_running");
    unlinkSync(lock);
  }
  const fd = openSync(lock, "wx", 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  let server: net.Server | undefined;
  try {
    if (existsSync(config.socket)) {
      if (!lstatSync(config.socket).isSocket()) fail("unsafe_socket_path");
      unlinkSync(config.socket);
    }
    const broker = new Broker(config);
    server = net.createServer((socket) => {
      let frame = "";
      const decoder = new StringDecoder("utf8");
      socket.setTimeout(30000, () => socket.destroy());
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        frame += decoder.write(chunk);
        if (Buffer.byteLength(frame) > MAX_FRAME) {
          socket.destroy();
          return;
        }
        if (!frame.includes("\n")) return;
        socket.pause();
        void (async () => {
          try {
            const req = z
              .object({
                role: z.enum(["codex", "claude"]),
                secret: z.string().max(128),
                binding: z.unknown(),
                op: z.string(),
                args: z.unknown(),
              })
              .strict()
              .parse(JSON.parse(frame.slice(0, frame.indexOf("\n"))));
            const secret =
              req.role === "codex" ? config.codexSecret : config.claudeSecret;
            if (
              Buffer.byteLength(req.secret) !== Buffer.byteLength(secret) ||
              !timingSafeEqual(Buffer.from(req.secret), Buffer.from(secret))
            )
              fail("pairing_rejected");
            if (digest(req.binding) !== digest(publicBinding(config)))
              fail("binding_mismatch");
            let value: unknown;
            if (req.op === "transport_written") {
              if (req.role !== "claude") fail("role_forbidden");
              const a = z
                .object({ task_id: id, lease: id })
                .strict()
                .parse(req.args);
              broker.assertLease(a.lease);
              broker.written(a.task_id, a.lease);
              value = { written: true };
            } else {
              if (!(req.op in schemas)) fail("unknown_operation");
              value = await broker.call(req.role, req.op as Op, req.args);
            }
            socket.end(JSON.stringify({ ok: true, value }) + "\n");
          } catch (e) {
            socket.end(
              JSON.stringify({
                ok: false,
                error:
                  e instanceof z.ZodError
                    ? "invalid_arguments"
                    : (e as Error).message,
              }) + "\n",
            );
          }
        })();
      });
    });
    await new Promise<void>((res, rej) => {
      server!.once("error", rej);
      server!.listen(config.socket, res);
    });
    chmodSync(config.socket, 0o600);
    const timer = setInterval(() => {
      broker.expire();
      broker.detectOffline();
    }, 1000);
    timer.unref();
    const stop = async () => {
      clearInterval(timer);
      await new Promise<void>((res) => server!.close(() => res()));
      if (existsSync(config.socket)) unlinkSync(config.socket);
      if (existsSync(lock)) unlinkSync(lock);
    };
    return { broker, server, stop };
  } catch (e) {
    server?.close();
    if (existsSync(lock)) unlinkSync(lock);
    throw e;
  }
}
