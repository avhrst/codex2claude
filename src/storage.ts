import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function atomicJson(path: string, value: unknown) {
  atomicText(path, JSON.stringify(value));
}
export function atomicText(path: string, content: string, replace = true) {
  const tmp = path + "." + randomUUID() + ".tmp";
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (replace) renameSync(tmp, path);
    else {
      // Publish complete bytes atomically, refusing an existing destination even
      // if another writer created it after the caller's existence check.
      linkSync(tmp, path);
      unlinkSync(tmp);
    }
    const dir = openSync(dirname(path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}
export function readJson<T>(path: string, fallback: T): T {
  let st;
  try {
    st = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.mode & 0o077 ||
    (process.getuid && st.uid !== process.getuid())
  )
    throw new Error("unsafe_store_file");
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
