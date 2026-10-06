import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { type Config, publicBinding } from "./config.js";
export async function rpc(
  c: Config,
  role: "codex" | "claude",
  op: string,
  args: unknown,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(c.socket);
    let data = "";
    const decoder = new StringDecoder("utf8");
    const timer = setTimeout(
      () => s.destroy(new Error("broker_timeout")),
      29000,
    );
    s.on("connect", () =>
      s.write(
        JSON.stringify({
          role,
          secret: role === "codex" ? c.codexSecret : c.claudeSecret,
          binding: publicBinding(c),
          op,
          args,
        }) + "\n",
      ),
    );
    s.on("data", (chunk) => {
      data += decoder.write(chunk);
      if (data.length > 8 * 1024 * 1024)
        s.destroy(new Error("broker_response_too_large"));
    });
    s.on("error", (e) => {
      clearTimeout(timer);
      reject(
        new Error(
          (e as NodeJS.ErrnoException).code === "ENOENT"
            ? "broker_unavailable"
            : e.message,
        ),
      );
    });
    s.on("end", () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(data);
        if (r.ok) resolve(r.value);
        else reject(new Error(r.error));
      } catch (e) {
        reject(e);
      }
    });
  });
}
