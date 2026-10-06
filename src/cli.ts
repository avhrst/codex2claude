#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startAdapter } from "./adapters.js";
import { startBroker } from "./broker.js";
import { initConfig, loadConfig, publicBinding } from "./config.js";
import { rpc } from "./ipc.js";
import { VERSION } from "./protocol.js";
import { atomicJson } from "./storage.js";

const argv = process.argv.slice(2);
const option = (key: string) => {
  const i = argv.indexOf(key);
  return i === -1 ? undefined : argv[i + 1];
};
const root = resolve(option("--project") ?? process.cwd());
const cli = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(cli), "..");
const output = (v: unknown) =>
  process.stdout.write(JSON.stringify(v, null, 2) + "\n");
function version(command: string) {
  try {
    return execFileSync(command, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
async function main() {
  const command = argv[0];
  if (command === "init") {
    const c = initConfig(root);
    const plugin = join(c.stateDir, "plugin");
    mkdirSync(plugin, { mode: 0o700, recursive: true });
    cpSync(join(packageRoot, "plugin"), plugin, { recursive: true });
    const mcp = {
      mcpServers: {
        codex2claude: {
          type: "stdio",
          command: process.execPath,
          args: [cli, "mcp", "codex", "--project", c.root],
        },
      },
    };
    atomicJson(join(plugin, "mcp.json"), {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      ...mcp,
    });
    atomicJson(join(plugin, ".mcp.json"), mcp);
    atomicJson(join(c.stateDir, "claude.mcp.json"), {
      mcpServers: {
        codex2claude: {
          command: process.execPath,
          args: [cli, "mcp", "claude", "--project", c.root],
        },
      },
    });
    output({
      initialized: true,
      binding: publicBinding(c),
      plugin,
      claude_config: join(c.stateDir, "claude.mcp.json"),
      next: "Start broker, install local plugin, then run claude-session interactively and personally accept native consent.",
    });
    return;
  }
  if (command === "doctor") {
    let auth: unknown;
    try {
      const raw = JSON.parse(
        execFileSync("claude", ["auth", "status"], {
          encoding: "utf8",
          timeout: 8000,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
      auth = {
        loggedIn: raw.loggedIn,
        authMethod: raw.authMethod,
        apiProvider: raw.apiProvider,
      };
    } catch {
      auth = { status: "unavailable_in_this_execution_environment" };
    }
    let bridge: any;
    try {
      bridge = await rpc(loadConfig(root), "codex", "bridge_status", {});
    } catch (e) {
      bridge = { status: (e as Error).message };
    }
    output({
      version: VERSION,
      node: process.version,
      claude: version("claude"),
      codex: version("codex"),
      auth,
      bridge,
      native_integration: bridge?.ready
        ? "Native nonce handshake confirmed. Task completion requires separate acceptance/result receipts."
        : "Native handshake not confirmed in this execution environment. Sandbox/Keychain access can affect auth status.",
      desktop_callback: "No automatic wakeup implemented.",
    });
    return;
  }
  if (command === "prepare-codex") {
    const c = loadConfig(root);
    const catalog = {
      name: "codex2claude-dev",
      interface: { displayName: "codex2claude — локальна розробка" },
      plugins: [
        {
          name: "codex2claude",
          source: { source: "local", path: "./.codex2claude/plugin" },
          policy: { installation: "AVAILABLE", authentication: "ON_USE" },
          category: "Productivity",
        },
      ],
    };
    const dir = join(c.root, ".agents/plugins");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "marketplace.json");
    if (
      existsSync(path) &&
      JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) !==
        JSON.stringify(catalog)
    )
      throw new Error("existing_marketplace_conflict");
    atomicJson(path, catalog);
    output({
      marketplace: path,
      plugin: join(c.stateDir, "plugin"),
      scope: "repo catalog only; no global config modified",
      next: "Install codex2claude from codex2claude-dev in Codex Plugins UI. Installation is a separate user action.",
    });
    return;
  }
  if (command === "broker") {
    const b = await startBroker(loadConfig(root));
    process.stderr.write("codex2claude broker listening (private local IPC)\n");
    for (const signal of ["SIGTERM", "SIGINT"] as const)
      process.once(signal, () => void b.stop().then(() => process.exit(0)));
    return;
  }
  if (command === "mcp") {
    const role = argv[1];
    if (role !== "codex" && role !== "claude")
      throw new Error("mcp_requires_codex_or_claude");
    await startAdapter(loadConfig(root), role);
    return;
  }
  if (command === "claude-session") {
    const c = loadConfig(root);
    // Inherit native auth unchanged. No --print, API, token handling or permission bypass.
    const { spawn } = await import("node:child_process");
    const child = spawn(
      "claude",
      [
        "--mcp-config",
        join(c.stateDir, "claude.mcp.json"),
        "--strict-mcp-config",
        "--dangerously-load-development-channels",
        "server:codex2claude",
      ],
      { cwd: c.root, stdio: "inherit" },
    );
    child.on("error", () => {
      process.stderr.write("native_claude_launch_failed\n");
      process.exitCode = 1;
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }
  if (command === "status") {
    output(
      await rpc(
        loadConfig(root),
        "codex",
        option("--task") ? "task_status" : "bridge_status",
        option("--task") ? { task_id: option("--task") } : {},
      ),
    );
    return;
  }
  if (command === "result") {
    output(
      await rpc(loadConfig(root), "codex", "task_result", {
        task_id: option("--task"),
      }),
    );
    return;
  }
  if (command === "spike") {
    output(
      await rpc(loadConfig(root), "codex", "request_architecture", {
        idempotency_key: option("--key") ?? "native-spike-1",
        goal: "Поясни архітектуру локального мосту з двома STDIO MCP adapters та broker. Поверни власну коротку консультацію українською через submit_result.",
        requirements: [
          "Один Codex виконавець, один native Claude Code архітектор.",
        ],
        constraints: [
          "Не читати файлів, не запускати команд, не змінювати конфігурацію.",
        ],
        files: [],
        questions: [
          "Чому один STDIO потік не можна поділити між двома MCP hosts?",
        ],
      }),
    );
    return;
  }
  if (command === "reconcile") {
    output(
      await rpc(loadConfig(root), "codex", "reconcile_delivery", {
        task_id: option("--task"),
        decision: option("--decision"),
      }),
    );
    return;
  }
  output({
    version: VERSION,
    commands: [
      "init",
      "prepare-codex",
      "doctor",
      "broker",
      "mcp codex",
      "mcp claude",
      "claude-session",
      "spike",
      "status [--task ID]",
      "result --task ID",
      "reconcile --task ID --decision retry|cancel",
    ],
    project: "--project PATH (default cwd)",
  });
}
main().catch((e) => {
  const msg = (e as Error).message;
  const code = (e as NodeJS.ErrnoException).code;
  process.stderr.write(
    "codex2claude: " +
      (/^[a-z_]+$/.test(msg)
        ? msg
        : code && /^[A-Z_]+$/.test(code)
          ? code
          : "operation_failed (check setup and arguments)") +
      "\n",
  );
  process.exitCode = 1;
});
