import { createHash } from "node:crypto";
import { z } from "zod";

export const VERSION = "0.1.0-alpha.1";
export const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
export const text = z.string().min(1).max(16000);
export const requestSchema = z
  .object({
    idempotency_key: id,
    goal: text,
    requirements: z.array(text).max(30).default([]),
    constraints: z.array(text).max(30).default([]),
    questions: z.array(text).max(30).default([]),
    files: z.array(z.string().min(1).max(512)).max(100).default([]),
    scope: text.optional(),
    validation: z.array(text).max(30).default([]),
    parent_task_id: id.optional(),
    originating_chat: id.optional(),
    deadline_seconds: z.number().int().min(30).max(86400).default(1800),
  })
  .strict();
export type Request = z.infer<typeof requestSchema>;
export const correlationSchema = z
  .object({ task_id: id, snapshot_id: id })
  .strict();
export const architectureResultSchema = z
  .object({
    kind: z.literal("architecture"),
    architecture: text,
    alternatives: z.array(text).max(20),
    contracts: z.array(text).max(30),
    implementation: z.array(text).max(30),
    risks: z.array(text).max(30),
    verification: z.array(text).max(30),
    clarifications: z.array(text).max(30),
  })
  .strict();
export const reviewResultSchema = z
  .object({
    kind: z.literal("review"),
    scope: text,
    examined_files: z.array(z.string().min(1).max(512)).max(100),
    skipped_files: z
      .array(
        z.object({ path: z.string().min(1).max(512), reason: text }).strict(),
      )
      .max(100),
    findings: z
      .array(
        z
          .object({
            severity: z.enum(["critical", "high", "medium", "low"]),
            file: z.string().min(1).max(512),
            line: z.number().int().positive(),
            evidence: text,
            suggestion: text,
          })
          .strict(),
      )
      .max(100),
    verdict: z.enum(["changes_requested", "no_findings", "inconclusive"]),
    limitations: z.array(text).max(30),
  })
  .strict();
export const resultSchema = z.discriminatedUnion("kind", [
  architectureResultSchema,
  reviewResultSchema,
]);
export type Result = z.infer<typeof resultSchema>;
export type State =
  | "queued"
  | "notified"
  | "accepted"
  | "running"
  | "completed"
  | "needs_human"
  | "failed"
  | "expired"
  | "delivery_uncertain"
  | "cancel_requested"
  | "cancelled";
export const terminal = new Set<State>([
  "completed",
  "failed",
  "expired",
  "cancelled",
]);
export interface Binding {
  projectId: string;
  worktreeId: string;
  root: string;
  bridgeSession: string;
  participantId: string;
}
export interface SnapshotFile {
  path: string;
  sha256: string;
  size: number;
  content: string;
  baseContent: string | null;
  status: string;
}
export interface Snapshot {
  id: string;
  files: SnapshotFile[];
  head: string | null;
  base: string | null;
  inclusion: "explicit-files";
  createdAt: string;
}
export interface Task {
  contractVersion: 1;
  id: string;
  kind: "architecture" | "review";
  binding: Binding;
  request: Request;
  requestHash: string;
  snapshot: Snapshot;
  state: State;
  createdAt: string;
  updatedAt: string;
  deadline: number;
  deliveryAttempts: number;
  delivery?: { lease: string; startedAt: string; writtenAt?: string };
  acceptance?: { snapshotId: string; lease: string; at: string };
  result?: { payload: Result; digest: string; at: string; late: boolean };
  cancelRequest?: { at: string; reason: string };
  humanAction?: string;
  cancelNotified?: string;
  progress?: { at: string; message: string };
  operatorStopped?: { at: string; lease: string; reason: string };
  events: { at: string; state: State; detail: string }[];
}
export interface Participant {
  lease: string;
  lastHeartbeat: number;
  handshake: boolean;
  nonce: string;
}
export function fail(code: string): never {
  throw new Error(code);
}
