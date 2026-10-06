import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { git } from "./config.js";
import { digest, fail, type Snapshot } from "./protocol.js";

const blocked =
  /(^|\/)(\.git|\.codex2claude|node_modules|\.env(?:\..*)?|\.npmrc|\.netrc|\.aws|\.ssh|\.claude|\.codex|credentials(?:\..*)?|.*\.(?:pem|key|p12|pfx))($|\/)/i;
export function snapshot(
  root: string,
  paths: string[],
  base?: string,
): Snapshot {
  let total = 0;
  const head = git(root, ["rev-parse", "--verify", "HEAD"]);
  const baseSha = base
    ? git(root, ["rev-parse", "--verify", base + "^{commit}"])
    : head;
  if (base && !baseSha) fail("invalid_base");
  const files = [...new Set(paths)].sort().map((path) => {
    if (
      isAbsolute(path) ||
      path.includes("\\") ||
      path.split("/").some((v) => v === ".." || v === "." || v === "") ||
      blocked.test(path)
    )
      fail("disallowed_context_path");
    const full = resolve(root, path);
    const rel = relative(root, full);
    if (rel.startsWith(".." + sep) || isAbsolute(rel))
      fail("context_outside_project");
    // Reject every symlink component, even links pointing back inside root.
    let current = root;
    for (const part of path.split("/")) {
      current = join(current, part);
      try {
        if (lstatSync(current).isSymbolicLink()) fail("context_symlink");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    let bytes: Buffer;
    let deleted = false;
    try {
      const st = lstatSync(full);
      if (!st.isFile() || st.size > 128 * 1024)
        fail("context_file_too_large_or_not_regular");
      if (!realpathSync(full).startsWith(root + sep))
        fail("context_outside_project");
      bytes = readFileSync(full);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      bytes = Buffer.alloc(0);
      deleted = true;
    }
    let baseContent: string | null = null;
    if (baseSha) {
      let baseBytes: Buffer | undefined;
      try {
        baseBytes = execFileSync(
          "git",
          ["-C", root, "show", `${baseSha}:${path}`],
          { maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "ignore"] },
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOBUFS")
          fail("base_too_large");
      }
      if (baseBytes) {
        baseContent = baseBytes.toString("utf8");
        if (
          baseBytes.includes(0) ||
          !Buffer.from(baseContent).equals(baseBytes)
        )
          fail("binary_base_unsupported");
      }
    }
    if (deleted && baseContent === null) fail("context_file_missing");
    const content = bytes.toString("utf8");
    if (
      bytes.includes(0) ||
      !Buffer.from(content).equals(bytes) ||
      baseContent?.includes("\0")
    )
      fail("binary_context_unsupported");
    total += bytes.length + Buffer.byteLength(baseContent ?? "");
    if (total > 1024 * 1024) fail("context_total_too_large");
    return {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      content,
      baseContent,
      status: deleted
        ? "deleted"
        : baseContent === null
          ? "added"
          : content === baseContent
            ? "unchanged"
            : "modified",
    };
  });
  const stable = {
    files,
    head,
    base: baseSha,
    inclusion: "explicit-files" as const,
  };
  return { ...stable, id: digest(stable), createdAt: new Date().toISOString() };
}
