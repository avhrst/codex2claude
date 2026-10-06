# Перевірки — 6 жовтня 2026

## Реалізовано

TypeScript CLI, private Unix broker, durable atomic store, два STDIO MCP adapters, native Channels nonce handshake, architecture/review contracts, immutable explicit snapshot, acceptance/result idempotency, bounded wait, deadline, cooperative cancel та uncertainty/reconciliation. Codex plugin templates, generated local runtime config, дві skills, repo marketplace і npm release metadata. Project-scoped direct MCP onboarding, progress receipts, heartbeat-driven offline states, immutable paging під час cancel, persisted request/result integrity checks та CLI-only operator stopped recovery. Request/wait/cancel/check доступні також у CLI.

## Локально перевірено

23 behavioral tests: request/accept/result idempotency; conflicting payloads; atomic restart recovery; foreign binding/role/lease/snapshot rejection; offline queue та heartbeat vs handshake; uncertain delivery без auto replay; cooperative cancellation і late results; expired accepted slot; private file modes та symlink/corrupt store rejection; path/size/binary boundaries; tracked/base, untracked і deletion snapshots; UTF-8 split frames; context paging; stale review; два real STDIO processes з synthetic hosts; fixture positive/boundary/negative behavior; existing-config preservation та exclusive writes; symlink/dangling-symlink config/catalog і preflight без partial write при config conflict; offline accepted lease recovery та durable progress; context stability при cancel; cancellation restart/idempotency; persisted request/result corruption; exact operator stopped reconciliation та late cancel acknowledgment без completion/replay; окремий `late_result`; стабільні canonical hashes у трьох process locales. `npm run check` — TypeScript і formatter. Обидві skills пройшли bundled quick_validate (PyYAML лише temporary venv).

Synthetic hosts у tests не є Claude. macOS sandbox забороняв Unix listen (`EPERM`); IPC tests і native broker виконано з дозволеним local transport у звичайному середовищі. Node 22 engine metadata не є доказом перевірки Node 22 — фактично Node 25.9.0.

`npm pack --ignore-scripts` створив `codex2claude-0.1.0-alpha.1.tgz`: CLI та skills включені, private state/node_modules виключені. Tarball встановлено в disposable `/private/tmp` project з production dependencies; packaged CLI `init` успішно створив binding, Claude config і generated plugin. npm publish не виконано.

Оновлений tarball містить 40 файлів, включно з `dist/onboarding.js`; private config/state виключені. Повторна disposable установка та packaged `prepare-codex --direct-mcp` успішні. Справжній STDIO adapter повернув дев'ять Codex tools без `resolve_stopped_task`; спроба виклику operator action як MCP tool відхилена `unknown_tool`.

## Підтверджено в native Claude Code

Користувач особисто підтвердив development-channel запуск у Terminal. CLI 2.1.291 працював зі звичайним claude.ai login (Max), без API/Agent SDK/keys. Bridge не читав auth stores. Native nonce tool call довів приймання channel event, а task acceptance/result — модельну відповідь.

| Задача | Task ID | Snapshot | Реальний результат |
|---|---|---|---|
| Architecture | `b2b3ef4d-921f-4364-bfa9-8c7bebf09729` | `74b7c407d94e…` | completed, власна структурована відповідь Claude, late=false |
| Review контрольного багу | `157872c9-45b0-4fd5-af15-f5c6c57517a0` | `602694e7fc82…` | completed, 2 findings, changes_requested |
| Review виправлення | `417aa75c-0b54-4936-a938-75929d957a2e` | `fabac9a8b266…` | completed, повний examined scope, no_findings, late=false |
| Review надійності | `599703be-cd4c-4255-887b-95f8b185408c` | `a436e75291d6…` | completed, 6 static findings, changes_requested, late=false |
| Повторне review надійності | `b76e933c-b91e-43fc-b3cb-e2e397487fe9` | `aaa6c3f3ec32…` | completed, попередні 6 findings закриті/прийняті, 1 low runtime-path finding, late=false |
| Фінальне scoped review | `39eacc51-2a62-4efa-97e1-398c8efe1bac` | `fc9e1865a8c4…` | completed, 6 examined files, no_findings, late=false |

На момент spike після виправлення старий review мав `check_snapshot.matches=false`; новий — true. Подальший initial commit змінив Git HEAD: ці історичні checks не є поточним approval для нового HEAD. Claude не запускав fixture, зробив static review; Codex окремо перевірив поведінку. Limitations Claude містять floating-point rounding та відсутність native test execution.

Контрольний broker `SIGKILL` після завершених задач → restart → adapter reconnect → новий nonce call → ready=true. Усі 3 completed receipts і result hashes збереглись. Active-execution crash/replay/lease semantics перевірені локальними tests, не native active crash.

Native review надійності знайшов terminal-state regression при late cancel acknowledgment, marketplace symlink path, dangling-symlink/TOCTOU config, неоднозначне поле пізнього result, locale-dependent hashes та надто сильну заяву про operator-only boundary. Код виправлено; same-user trust boundary явно задокументовано замість непідтвердженої ізоляції оператора. Після зміни canonical sort оновлений broker відновив усі чотири receipts без зміни 13 попередніх digests. Новий snapshot передано в parent-bound rereview.

Повторний native reviewer підтвердив виправлення шести попередніх пунктів і не знайшов correctness/safety blocker. Новий low finding про stale Homebrew runtime path закрито explicit `--refresh-direct-mcp` із точним template match та user-settings preservation. Тести перевіряють simulated runtime upgrade і відмову refresh після user additions. Також усунуто старий dangling-symlink fallback у `readJson`, щоб не заміняти state link порожнім store. Same-user concurrent writer лишається явно задокументованою межею; автоматичного операторського consent не додано.

Фінальне scoped native review повернуло `no_findings`, перевірило всі шість файлів і п'ять context pages. Receipt digest `587b3bb6af01870951c3a6c6c64448509199268054046e024595eb1eccbe3f4e`; перед commit `check_snapshot.matches=true`. Core broker/adapters/protocol/AGENTS не змінювалися після попереднього review. Неблокуюча UX межа: refresh MCP також відмовляє, якщо marketplace має conflict. Після commit Git HEAD змінюється, тому ці receipts є доказами конкретних pre-commit bytes, а не автоматичним approval будь-якого майбутнього HEAD.

Raw receipts та власна відповідь Claude доступні у private `.codex2claude/evidence/*.json`, не включаються в Git/npm. Цей файл зберігає лише synthetic IDs і стислий висновок. Історичні receipts мають runtime першого spike; після оновлення adapter native session слід перезапустити, якщо змінено adapter поведінку.

## Desktop та межі підтвердження

Запити координував Codex Desktop, але для цього spike він запускав через shell real MCP client (`scripts/live-spike.mjs`), який викликав Codex adapter. **Це ще не доказ установленого Desktop plugin tool loading.** Підготовлений package/catalog не дорівнює installed plugin. User plugin configuration не змінюється без окремої авторизації.

Після initial commit створено repo-only `.codex/config.toml` через `prepare-codex --direct-mcp`. `codex mcp list --json` підтвердив enabled STDIO server із правильними absolute command/args/cwd і timeout. Native Desktop tool loading у цьому active chat ще не з'явилось; refresh/new turn треба перевіряти окремо. Direct config і full plugin MCP одночасно не вмикати.

Automatic callback/wakeup саме вихідного Desktop chat не реалізований. Підтримується bounded MCP wait під час turn і manual resume/status після його закінчення. `codex queue` probe для exact thread `01a11019-11c7-70a0-b4aa-eb87a6d2ecd3` повернув exit 0, receipt `01a11036-ecf0-7503-bc7b-ab9bdc7c8b71`. Actual delivery/new turn не підтверджені; queued receipt не став callback implementation у bridge.

Негативний offline-Claude test — synthetic participant; повністю закривати живу native сесію для такого тесту не виконувалось. Native organization-policy відмови та live cancellation не перевірено. Platform scope — цей macOS host; Windows named-pipe adapter і Linux packaging відсутні. Retention — локальний store без автоматичного видалення історії, один writer.
