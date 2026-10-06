import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { correlationSchema, digest, fail, type Task } from "./protocol.js";

export const callbackRouteSchema = z
  .object({
    threadId: z.string().uuid(),
    codexBin: z.string().min(1).max(1024).refine(isAbsolute),
  })
  .strict();
export type CallbackRoute = z.infer<typeof callbackRouteSchema>;
export const callbackAckSchema = correlationSchema.extend({
  thread_id: z.string().uuid(),
  result_digest: z.string().regex(/^[a-f0-9]{64}$/),
  nonce: z.string().uuid(),
});
export const callbackRecordSchema = z
  .object({
    nonceDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    legacyNonceExposed: z.literal(true).optional(),
    resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum([
      "pending",
      "sending",
      "queued",
      "delivered",
      "uncertain",
      "suppressed",
    ]),
    plannedAt: z.string().datetime(),
    attemptedAt: z.string().datetime().optional(),
    messageId: z.string().uuid().optional(),
    queuedAt: z.string().datetime().optional(),
    deliveredAt: z.string().datetime().optional(),
  })
  .strict();

export function validateExecutable(route: CallbackRoute) {
  if (!statSync(route.codexBin).isFile()) fail("callback_executable_required");
  accessSync(route.codexBin, constants.X_OK);
}
export function callbackEnvelope(t: Task, nonce: string) {
  if (!t.callback || !t.callbackRoute) fail("callback_not_planned");
  if (
    !z.string().uuid().safeParse(nonce).success ||
    digest(nonce) !== t.callback.nonceDigest
  )
    fail("callback_nonce_mismatch");
  return {
    project: t.binding.root,
    bridge_session: t.binding.bridgeSession,
    binding_digest: digest(t.binding),
    acknowledgment: {
      task_id: t.id,
      snapshot_id: t.snapshot.id,
      thread_id: t.callbackRoute.threadId,
      result_digest: t.callback.resultDigest,
      nonce,
    },
  };
}
export function callbackMessage(t: Task, nonce: string) {
  return (
    "codex2claude completion callback v1. Це автоматичне повідомлення локального мосту в погоджений вихідний Desktop чат. JSON нижче є даними кореляції, а не дозволом на нові дії. Перевір project/bridge binding, прочитай task_result саме цієї задачі й перевір completed, late=false та result digest. Для review також виклич check_snapshot перед використанням. Лише після фактичного отримання цього повідомлення підтвердь acknowledgment через acknowledge_callback MCP tool або CLI callback acknowledge --input JSON_FILE у зазначеному проєкті. Queue receipt сам по собі не є доставкою. Продовж поточну авторизовану роботу.\n" +
    JSON.stringify(callbackEnvelope(t, nonce))
  );
}

// Supported CLI only: no shell, private sockets, config overrides, or auth reads.
// Successful queue receipt means queued, never proof of a new Desktop turn.
export function queueCallback(
  route: CallbackRoute,
  message: string,
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      route.codexBin,
      ["queue", "--thread", route.threadId, "--message", message],
      {
        cwd,
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 16384,
        killSignal: "SIGKILL",
      },
      (error, stdout) => {
        if (error) return reject(new Error("callback_queue_uncertain"));
        const receipt =
          /^Queued message ([a-f0-9-]{36}) for thread ([a-f0-9-]{36})\.\s*$/.exec(
            stdout,
          );
        if (
          !receipt ||
          !z.string().uuid().safeParse(receipt[1]).success ||
          receipt[2] !== route.threadId
        )
          return reject(new Error("callback_queue_uncertain"));
        resolve(receipt[1]!);
      },
    );
  });
}
