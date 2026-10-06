# codex2claude

Локальний міст: **Codex Desktop — виконавець**, **жива нативна Claude Code сесія — архітектор і рев'ювер**. Два STDIO MCP adapters, private Unix IPC, durable tasks і review точних байтів. Використовує звичайний Claude Code login користувача; Anthropic API/Agent SDK не застосовує.

Experimental alpha. Native Channels handshake та architecture round trip перевірені 6 жовтня 2026 на Claude Code 2.1.291. Desktop plugin install/tool loading перевіряється окремо; автоматичне пробудження чату після завершення turn не реалізоване. Повний поточний статус — [verification](docs/verification.md).

## Запуск із checkout

Поточний alpha призначений для локального macOS host. Потрібні Node 22+, npm, встановлений Claude Code з native claude.ai login і Codex Desktop. Реально протестовано Node 25.9.0, Codex CLI 0.160.0. Ніякого глобального `npm install` не потрібно.

```sh
cd /Users/oleksii/Code/codex2claude
npm ci --ignore-scripts
npm run build
node dist/cli.js init
node dist/cli.js prepare-codex --direct-mcp
node dist/cli.js broker
```

Broker залишити у першому terminal. У другому:

```sh
cd /Users/oleksii/Code/codex2claude
node dist/cli.js claude-session
```

Користувач особисто підтверджує native development-channel consent та потрібний project trust/MCP consent. Claude сам запускає adapter. `node dist/cli.js status` має показати `ready: true`, що вимагає native nonce tool call. Існування binary або heartbeat недостатньо.

Плагін генерується в ignored `.codex2claude/plugin`, з абсолютними runtime paths поточного host. Його skills/templates — у [plugin](plugin). Native MCP config — `.codex2claude/claude.mcp.json`. Pairing та source snapshots залишаються локальними private files, не комітяться.

`prepare-codex --direct-mcp` створює project-scoped `.codex/config.toml` із точними runtime paths, без глобальних змін. Чужий config не перезаписує. Після refresh MCP/new chat треба перевірити фактичний native `codex2claude.bridge_status` tool call у Desktop. Згенерований config локальний та ignored; він діє лише для trusted project.

Після зміни Node runtime виконати `init` та `prepare-codex --refresh-direct-mcp`: команда оновлює лише config точного generated формату; user additions зберігає як conflict.

Для встановлення повного плагіна зі skills див. [setup](docs/setup.md). CLI installation змінює user plugin configuration, тому це окрема явна дія користувача. Використовуй один спосіб підключення MCP: direct project config або installed plugin.

```sh
node dist/cli.js doctor
npm test
```

Якщо sandbox блокує Unix socket або Keychain status, запускати native процеси й локальні transport тести у звичайному terminal. Не вимикати permissions Claude. `loggedIn:false` із sandbox може бути відмінністю доступу до Keychain; офіційна перевірка поза ним — `claude auth status`.

## Робочий workflow

В установленому plugin Codex використовує `claude-architecture` або `claude-review`: request → bounded wait/status → result. Якщо turn уже завершився, користувач відновлює чат і просить отримати результат. Review applicability перевіряється `check_snapshot`; змінені bytes потребують нового review.

Architecture/review за замовчуванням не дозволяють Claude змінювати файли чи виконувати тести. Prompt не є sandbox, native permissions зберігаються. Неточна доставка потребує явного reconciliation; `cancel_requested` не означає примусову зупинку.

CLI також підтримує `request architecture|review --input request.json`, `wait --task ID`, `cancel --task ID --reason MESSAGE` та `check --task ID`. JSON request містить унікальний `idempotency_key`, `goal`, явні `files`; для review також `scope`. Отриманий receipt ще не є результатом Claude.

Якщо прийнята задача втратила native сесію, вона лишається `needs_human` без повтору. Оператор після особистого підтвердження закриття сесії може виконати `resolve-stopped`; точний порядок — у [setup](docs/setup.md#reconnect-та-контроль).

- [Архітектура й межі MVP](docs/architecture.md)
- [Підписка та permissions](docs/subscription-boundary.md)
- [Capability gate](docs/capability-gate.md)
- [Handoff і незмінні вимоги](CODEX_HANDOFF.md)

Код під MIT. Репозиторій збережено в Git та pushed за явною інструкцією користувача; npm package підготовлено локально, publish не виконано.
