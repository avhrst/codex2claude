# Перевірки — 6 жовтня 2026

## Реалізовано

TypeScript CLI, private Unix broker, durable atomic store, два STDIO MCP adapters, native Channels nonce handshake, architecture/review contracts, immutable explicit snapshot, acceptance/result idempotency, bounded wait, deadline, cooperative cancel та uncertainty/reconciliation. Codex plugin templates, generated local runtime config, дві skills, repo marketplace і npm release metadata.

## Локально перевірено

14 behavioral tests: request/accept/result idempotency; conflicting payloads; atomic restart recovery; foreign binding/role/lease/snapshot rejection; offline queue та heartbeat vs handshake; uncertain delivery без auto replay; cooperative cancellation і late results; expired accepted slot; private file modes та symlink/corrupt store rejection; path/size/binary boundaries; tracked/base, untracked і deletion snapshots; UTF-8 split frames; context paging; stale review; два real STDIO processes з synthetic hosts; fixture positive/boundary/negative behavior. `npm run check` — TypeScript і formatter. Обидві skills пройшли bundled quick_validate (PyYAML лише temporary venv).

Synthetic hosts у tests не є Claude. macOS sandbox забороняв Unix listen (`EPERM`); IPC tests і native broker виконано з дозволеним local transport у звичайному середовищі. Node 22 engine metadata не є доказом перевірки Node 22 — фактично Node 25.9.0.

`npm pack --ignore-scripts` створив `codex2claude-0.1.0-alpha.1.tgz`: CLI та skills включені, private state/node_modules виключені. Tarball встановлено в disposable `/private/tmp` project з production dependencies; packaged CLI `init` успішно створив binding, Claude config і generated plugin. npm publish не виконано.

## Підтверджено в native Claude Code

Користувач особисто підтвердив development-channel запуск у Terminal. CLI 2.1.291 працював зі звичайним claude.ai login (Max), без API/Agent SDK/keys. Bridge не читав auth stores. Native nonce tool call довів приймання channel event, а task acceptance/result — модельну відповідь.

| Задача | Task ID | Snapshot | Реальний результат |
|---|---|---|---|
| Architecture | `b2b3ef4d-921f-4364-bfa9-8c7bebf09729` | `74b7c407d94e…` | completed, власна структурована відповідь Claude, late=false |
| Review контрольного багу | `157872c9-45b0-4fd5-af15-f5c6c57517a0` | `602694e7fc82…` | completed, 2 findings, changes_requested |
| Review виправлення | `417aa75c-0b54-4936-a938-75929d957a2e` | `fabac9a8b266…` | completed, повний examined scope, no_findings, late=false |

Після виправлення старий review `check_snapshot.matches=false`; новий — true. Claude не запускав fixture, зробив static review; Codex окремо перевірив поведінку. Limitations Claude містять floating-point rounding та відсутність native test execution.

Контрольний broker `SIGKILL` після завершених задач → restart → adapter reconnect → новий nonce call → ready=true. Усі 3 completed receipts і result hashes збереглись. Active-execution crash/replay/lease semantics перевірені локальними tests, не native active crash.

Raw receipts та власна відповідь Claude доступні у private `.codex2claude/evidence/*.json`, не включаються в Git/npm. Цей файл зберігає лише synthetic IDs і стислий висновок. Історичні receipts мають runtime першого spike; після оновлення adapter native session слід перезапустити, якщо змінено adapter поведінку.

## Desktop та межі підтвердження

Запити координував Codex Desktop, але для цього spike він запускав через shell real MCP client (`scripts/live-spike.mjs`), який викликав Codex adapter. **Це ще не доказ установленого Desktop plugin tool loading.** Підготовлений package/catalog не дорівнює installed plugin. User plugin configuration не змінюється без окремої авторизації.

Automatic callback/wakeup саме вихідного Desktop chat не реалізований. Підтримується bounded MCP wait під час turn і manual resume/status після його закінчення. `codex queue` є в CLI, але exact Desktop routing не доведено й у bridge не застосовується.

Негативний offline-Claude test — synthetic participant; повністю закривати живу native сесію для такого тесту не виконувалось. Native organization-policy відмови та live cancellation не перевірено. Platform scope — цей macOS host; Windows named-pipe adapter і Linux packaging відсутні. Retention — локальний store без автоматичного видалення історії, один writer.
