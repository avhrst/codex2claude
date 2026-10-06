// Real native acceptance harness. This is not a replacement model host.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const root = process.cwd();
const client = new Client({
  name: "codex2claude-live-evidence",
  version: "0.1.0",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist/cli.js"), "mcp", "codex", "--project", root],
  stderr: "inherit",
});
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};
try {
  await client.connect(transport);
  const status = await call("bridge_status", {});
  if (!status.ready) throw new Error("native_handshake_not_ready");
  const review = process.argv.includes("--review");
  const parent = process.argv[process.argv.indexOf("--parent") + 1];
  const args = review
    ? {
        idempotency_key: process.argv.includes("--fixed")
          ? "native-review-fixed-1"
          : "native-review-bug-1",
        goal: "Переглянь контрольну функцію discountTotal: amount має бути не відʼємним, percent від 0 до 100; знижка 20% на 100 має дати 80. Не запускай тести й не змінюй файлів. Поверни findings із рядками через submit_result.",
        scope:
          "Тільки examples/review-fixture/discount.js; синтетичний відкритий приклад без приватного коду.",
        files: ["examples/review-fixture/discount.js"],
        questions: ["Чи правильна формула та валідація?"],
        validation: [
          "Контрольні очікування визначені в goal; native reviewer не запускає код.",
        ],
        ...(process.argv.includes("--parent")
          ? { parent_task_id: parent }
          : {}),
      }
    : {
        idempotency_key: "native-architecture-1",
        goal: "Дай власну коротку архітектурну консультацію для локального мосту Codex Desktop → native Claude Code. Поясни два різні STDIO адаптери, broker, explicit acceptance та immutable review snapshot. Відповідай українською через submit_result; не читай файлів і не запускай команд.",
        requirements: [
          "Зберегти нативну підписку, permissions та головний інтерфейс Codex.",
        ],
        constraints: [
          "Не API/Agent SDK; не credentials; без автоматичного Desktop callback у першому MVP.",
        ],
        files: [],
      };
  const receipt = await call(
    review ? "request_review" : "request_architecture",
    args,
  );
  console.log(JSON.stringify({ event: "requested", ...receipt }));
  const until = Date.now() + 180000;
  let result;
  while (Date.now() < until) {
    result = await call("wait_for_task", {
      task_id: receipt.task_id,
      timeout_seconds: 20,
    });
    if (
      result.result ||
      ["failed", "expired", "cancelled", "needs_human"].includes(result.state)
    )
      break;
    console.log(
      JSON.stringify({
        event: "waiting",
        task_id: receipt.task_id,
        state: result.state,
      }),
    );
    await new Promise((r) => setTimeout(r, 500));
  }
  const check = review
    ? await call("check_snapshot", { task_id: receipt.task_id })
    : null;
  mkdirSync(join(root, ".codex2claude/evidence"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(
    join(root, ".codex2claude/evidence", receipt.task_id + ".json"),
    JSON.stringify(
      {
        host: "Codex Desktop shell launching real MCP client; Desktop plugin tool loading remains separate",
        status,
        receipt,
        result,
        check,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify(
      { event: "finished", ...result, snapshot_check: check },
      null,
      2,
    ),
  );
  if (
    result?.state !== "completed" ||
    !result.result ||
    result.result_receipt?.late
  )
    process.exitCode = 1;
} finally {
  await client.close();
}
