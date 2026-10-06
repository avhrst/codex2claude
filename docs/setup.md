# Локальне підключення

## Підготовка

У checkout виконати `npm ci --ignore-scripts`, `npm run build`, `node dist/cli.js init`, `node dist/cli.js prepare-codex`. `init` повторюваний: binding/pairing не змінює, generated plugin оновлює із templates. Якщо перемістити checkout або змінити worktree, потрібен новий init у новому root; копіювати private binding не слід.

`prepare-codex` створює `.agents/plugins/marketplace.json`; чужий catalog відхиляється як conflict. Global config і credentials не змінює. Сумісний legacy catalog `.claude-plugin/marketplace.json` також є у repo. Для встановлення plugin клієнт завантажує private generated folder `.codex2claude/plugin`; npm package містить лише generic templates, не host-specific private state.

## Codex Desktop

Підготовлений plugin має portable manifest, STDIO MCP config, compatibility overlay та два skills. Поточний CLI 0.160.0 у read-only `marketplace list` не показав repo catalog автоматично. Надійний документований шлях — explicit local marketplace registration; це змінює user plugin configuration і виконується користувачем або після його окремої авторизації:

```sh
cd /Users/oleksii/Code/codex2claude
codex plugin marketplace add /Users/oleksii/Code/codex2claude
codex plugin add codex2claude@codex2claude-dev
```

Альтернатива — Plugins UI: local source `codex2claude-dev` → `codex2claude` → Install, якщо source уже видно. Принципово важливо перевірити фактичне Desktop tool loading після refresh/new turn, а не тільки CLI receipt. Якщо клієнт просить restart, не закривати активну роботу без рішення користувача.

В поточному/новому чаті цього saved project попросити: «Використай codex2claude bridge_status». Має бути саме native MCP tool call з `ready:true`. Потім «Використай claude-architecture для синтетичного питання». Result tool має повернути explicit acceptance/result receipt. Наявність skills у списку не доводить runtime MCP connection.

## Claude Code

Перший terminal — `node dist/cli.js broker`. Другий — `node dist/cli.js claude-session`; або відкрити `scripts/start-claude.command` на цьому Mac. CLI wrapper запускає:

```sh
claude --mcp-config /Users/oleksii/Code/codex2claude/.codex2claude/claude.mcp.json \
  --strict-mcp-config \
  --dangerously-load-development-channels server:codex2claude
```

Це інтерактивна native сесія, без `-p`, Agent SDK, API keys чи permission bypass. `strict-mcp-config` обмежує MCP servers цього запуску нашим config; native settings/auth/permissions wrapper не змінює. Користувач приймає native channel warning («I am using this for local development») і довіру/MCP consent, якщо Claude їх запитає. Не запускати другий channel adapter для того самого participant одночасно.

Через кілька секунд `status` показує handshake. Якщо connected=true, handshake=false, подія ще не підтверджена Claude: перевірити native permission prompt, `/mcp` та Channels registration. Organization policy може блокувати саме Channels при працездатному MCP. Подробиці — [офіційний research-preview workflow](https://code.claude.com/docs/en/channels-reference).

Для login користувач застосовує native Claude flow. Bridge не приймає credentials. Повна auth status команда може виводити account metadata; `doctor` показує лише sanitized поля.

## Reconnect та контроль

`status --task ID`, `result --task ID` читають receipts. `reconcile --task ID --decision retry|cancel` лише для unaccepted delivery, після ручного звіряння native session. Accepted task не переноситься в новий lease автоматично. Не робити duplicate native turn через resume/background commands.

Рестарт broker: Ctrl-C у його terminal, потім знову `broker`. Задачі зберігаються; readiness перевіряється новим nonce. Crash active execution потребує reconciliation людиною, не автоматичного повтору.

## Локальні evidence scripts

`node scripts/live-spike.mjs` використовує справжній Codex MCP adapter та живий native channel для синтетичного architecture request. `--review` перевіряє fixture review. Це MCP client із Desktop shell, не доказ установленого Desktop plugin. Raw receipts зберігаються в private `.codex2claude/evidence/`.

`npm pack` створює release candidate без publish. Код під MIT. Install/publish/commit/push — окремі дії, не побічний ефект build/test.
