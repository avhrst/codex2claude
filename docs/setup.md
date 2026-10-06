# Локальне підключення

## Підготовка

У checkout виконати `npm ci --ignore-scripts`, `npm run build`, `node dist/cli.js init`, `node dist/cli.js prepare-codex`. `init` повторюваний: binding/pairing не змінює, generated plugin оновлює із templates. Якщо перемістити checkout або змінити worktree, потрібен новий init у новому root; копіювати private binding не слід.

`prepare-codex` створює `.agents/plugins/marketplace.json`; чужий catalog відхиляється як conflict. Global config і credentials не змінює. Сумісний legacy catalog `.claude-plugin/marketplace.json` також є у repo. Для встановлення plugin клієнт завантажує private generated folder `.codex2claude/plugin`; npm package містить лише generic templates, не host-specific private state.

## Codex Desktop

### MCP лише для цього проєкту

`node dist/cli.js prepare-codex --direct-mcp` створює локальний ignored `.codex/config.toml`. STDIO command/args/cwd містять абсолютні paths цього host; global config не змінюється. Якщо project config уже містить інші налаштування, команда завершується `existing_codex_config_conflict` і зберігає файл. Symlink у `.agents`, `.agents/plugins`, marketplace або `.codex`/config відхиляються, включно з dangling symlink. Обидві цілі перевіряються до записів; нові файли створюються ексклюзивно й атомарно. Concurrent writer/disk failure між записами все ще може потребувати ручного reconciliation. Наявний config слід редагувати окремо, зберігаючи власні налаштування.

Codex застосовує project config тільки для trusted project. Цей scope і спільність MCP settings Desktop/CLI описані в [офіційній документації](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). Таймаут tool становить 35 секунд для bounded wait до 25 секунд. `codex mcp list --json` підтверджує конфігурацію, але не Desktop tool loading.

Після оновлення Homebrew Node його версійний `process.execPath` може зникнути. Оновити generated runtime paths: `node dist/cli.js init`, потім `node dist/cli.js prepare-codex --refresh-direct-mcp`. Refresh дозволений лише для точного generated template цього самого root: маркер, набір полів, arguments, cwd і timeouts мають збігатися; змінюються лише node/CLI paths. User additions або зміни інших settings дають conflict і зберігаються. Symlink checks залишаються; перед replacement повторно звіряється попередній вміст. Це явний refresh власного generated server config, не merge довільної TOML config. Якщо client використовує cached config, reload MCP після оновлення.

Після reload MCP або нового turn/chat у проєкті викликати native `codex2claude.bridge_status`. Якщо tools ще не доступні в поточному chat, CLI smoke не видавати за Desktop integration. Не вмикати одночасно direct MCP і plugin MCP під тим самим ім'ям.

### Повний plugin зі skills

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

Після 10 секунд без heartbeat `accepted`/`running` переходить у `needs_human`, `notified` — у `delivery_uncertain`. Progress message зберігається в receipt. Той самий adapter lease може повернутись і завершити попередню роботу; повторний `accept_task` повертає `execute:false`. Перезапущений adapter із новим lease не успадковує acceptance.

Якщо прийнята задача вже не може повернути результат, **людина спершу закриває native сесію та переконується, що виконання зупинилось**. Потім читає `acceptance.lease` у `status --task ID` та виконує:

```sh
node dist/cli.js resolve-stopped --task TASK_ID --lease ACCEPTED_LEASE \
  --confirm-native-stopped --reason "Особисто закрив native сесію; виконання зупинене"
```

Команда відмовляє, якщо adapter цього lease ще connected, lease не збігається, задача не прийнята або вже має result. Чекати щонайменше 10 секунд після закриття adapter. Результат — `failed` із operator receipt та вільним слотом, без replay, completion або approval. Це операторська CLI дія, її немає серед MCP tools. Прапорець є людським підтвердженням, а не примусовою перевіркою зупинки процесу. Агент не повинен встановлювати його на підставі самого timeout/heartbeat. Пізній result, якщо з'явиться, зберігається з `late:true`.

Приховування з MCP catalog не є окремою межею автентифікації: trusted процес того самого користувача з shell доступом може викликати CLI/RPC і прочитати pairing. Окремої operator role/TTY authentication в MVP немає. Потрібне реальне підтвердження користувача; сама можливість передати прапорець його не замінює.

## Запит без plugin skills

Для direct MCP Codex може викликати інструменти безпосередньо. Для CLI створити request JSON, наприклад:

```json
{
  "idempotency_key": "my-architecture-unique-1",
  "goal": "Запропонуй контракт компонентів на підставі явного snapshot.",
  "constraints": ["Консультація без виконання коду та зміни файлів"],
  "files": ["src/protocol.ts"]
}
```

```sh
node dist/cli.js request architecture --input request.json
node dist/cli.js wait --task TASK_ID --seconds 20
node dist/cli.js result --task TASK_ID
node dist/cli.js check --task TASK_ID
node dist/cli.js cancel --task TASK_ID --reason "Задача більше не потрібна"
```

Для `request review` додати `scope`, явні файли й за потреби `base`, `questions`, `validation`, `parent_task_id`. Validation описує лише реально виконані checks. Кожен новий snapshot потребує нового idempotency key. `check` також враховує Git HEAD/base: новий commit може зробити історичний receipt stale навіть за однакових робочих bytes.

`task_result` і `wait_for_task` повертають payload у `result` лише для своєчасного `completed`. Пізній/скасований результат доступний як `late_result`; він не підтверджує completion чи approval. Додатково перевіряти `state`, `result_receipt.late` та snapshot applicability.

## Локальні evidence scripts

`node scripts/live-spike.mjs` використовує справжній Codex MCP adapter та живий native channel для синтетичного architecture request. `--review` перевіряє fixture review. Це MCP client із Desktop shell, не доказ установленого Desktop plugin. Raw receipts зберігаються в private `.codex2claude/evidence/`.

`npm pack` створює release candidate без publish. Код під MIT. Install/publish/commit/push — окремі дії, не побічний ефект build/test.
