import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function atomicJson(path: string, value: unknown) {
  const tmp = path + "." + randomUUID() + ".tmp";
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
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
  if (!existsSync(path)) return fallback;
  const st = lstatSync(path);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.mode & 0o077 ||
    (process.getuid && st.uid !== process.getuid())
  )
    throw new Error("unsafe_store_file");
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
