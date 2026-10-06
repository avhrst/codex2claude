import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { digest, fail, type Binding } from "./protocol.js";
import { atomicJson } from "./storage.js";
import { z } from "zod";

export interface Config extends Binding {
  version: 1;
  stateDir: string;
  socket: string;
  codexSecret: string;
  claudeSecret: string;
}
export function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 2 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}
export function identity(
  root: string,
): Pick<Binding, "root" | "projectId" | "worktreeId"> {
  root = realpathSync(root);
  const dir = git(root, ["rev-parse", "--absolute-git-dir"]) ?? root;
  const common = git(root, ["rev-parse", "--git-common-dir"]);
  return {
    root,
    projectId: digest(common ? realpathSync(resolve(root, common)) : root),
    worktreeId: digest({ root, dir }),
  };
}
export function privateDirectory(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.mode & 0o077 ||
    (process.getuid && st.uid !== process.getuid())
  )
    fail("unsafe_private_directory");
}
export function loadConfig(root: string): Config {
  root = realpathSync(root);
  const dir = join(root, ".codex2claude");
  privateDirectory(dir);
  const file = join(dir, "config.json");
  const st = lstatSync(file);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.mode & 0o077 ||
    (process.getuid && st.uid !== process.getuid())
  )
    fail("unsafe_config");
  const c = z
    .object({
      version: z.literal(1),
      root: z.string(),
      projectId: z.string(),
      worktreeId: z.string(),
      bridgeSession: z.string().uuid(),
      participantId: z.literal("claude-local"),
      stateDir: z.string(),
      socket: z.string(),
      codexSecret: z.string().regex(/^[a-f0-9]{64}$/),
      claudeSecret: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .parse(JSON.parse(readFileSync(file, "utf8"))) as Config;
  if (
    c.version !== 1 ||
    c.root !== root ||
    digest(identity(root)) !==
      digest({ root: c.root, projectId: c.projectId, worktreeId: c.worktreeId })
  )
    fail("binding_changed");
  if (
    c.stateDir !== dir ||
    !c.codexSecret ||
    !c.claudeSecret ||
    !c.bridgeSession
  )
    fail("invalid_config");
  if (
    c.socket !==
    `/private/tmp/c2c-${process.getuid?.() ?? "local"}-${c.worktreeId.slice(0, 16)}/broker.sock`
  )
    fail("invalid_socket_binding");
  privateDirectory(resolve(c.socket, ".."));
  return c;
}
export function initConfig(root: string): Config {
  const binding = identity(root);
  const stateDir = join(binding.root, ".codex2claude");
  privateDirectory(stateDir);
  if (existsSync(join(stateDir, "config.json"))) return loadConfig(root);
  // Fixed per-user /tmp namespace: independent of launcher TMPDIR.
  const socketDir = `/private/tmp/c2c-${process.getuid?.() ?? "local"}-${binding.worktreeId.slice(0, 16)}`;
  privateDirectory(socketDir);
  const config: Config = {
    version: 1,
    ...binding,
    bridgeSession: randomUUID(),
    participantId: "claude-local",
    stateDir,
    socket: join(socketDir, "broker.sock"),
    codexSecret: randomBytes(32).toString("hex"),
    claudeSecret: randomBytes(32).toString("hex"),
  };
  atomicJson(join(stateDir, "config.json"), config);
  return config;
}
export function publicBinding(c: Config): Binding {
  return {
    root: c.root,
    projectId: c.projectId,
    worktreeId: c.worktreeId,
    bridgeSession: c.bridgeSession,
    participantId: c.participantId,
  };
}
