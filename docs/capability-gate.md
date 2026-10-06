# Capability gate — 6 жовтня 2026

Підтверджено на цьому host:

- Repository `/Users/oleksii/Code/codex2claude` початково був порожній. Після явної інструкції користувача initial commit `8b4348e` pushed у `origin/main` (`avhrst/codex2claude`).
- Node 25.9.0, npm 11.12.1, Claude Code 2.1.291, Codex CLI 0.160.0.
- Native `claude auth status` поза sandbox: loggedIn=true, authMethod=claude.ai, first-party provider, Max subscription. Усередині sandbox loggedIn=false; це не доказ відсутності login. Жодні auth files/Keychain contents не читались.
- `codex queue` probe `c2c-20261006-desktop-1` для цього Desktop chat `01a11019-11c7-70a0-b4aa-eb87a6d2ecd3` повернув exit 0 і receipt `01a11036-ecf0-7503-bc7b-ab9bdc7c8b71`. Після завершення попереднього turn exact повідомлення фактично прийшло в цей чат і запустило новий turn (08:36 UTC). Це доказ CLI delivery, окремий від task-completion callback acknowledgment та native MCP loading.
- SDK 1.32.1, Zod 4.6.5, TypeScript 7.0.2, Node types 26.6.4 перевірені в npm і закріплені lockfile. Для продукту мінімум Node 22; реально протестовано тільки installed Node 25.9.0.

Рішення за [офіційним Codex plugin contract](https://developers.openai.com/plugins/build/plugins): portable `plugin.json`, `mcp.json` із STDIO, skills; compatibility overlay `.codex-plugin/plugin.json` і `.mcp.json`; local marketplace, без hosted endpoint. `init` генерує host-specific абсолютні runtime paths тільки в ignored state directory.

[Claude Channels reference](https://code.claude.com/docs/en/channels-reference) визначає `experimental['claude/channel']`, `notifications/claude/channel`, string metadata, інтерактивний development flag та explicit reply tools. Transport write не є native acknowledgment. Наш readiness потребує nonce tool call; acceptance/result також explicit.

Development flag із `--help` дає exit 0; це тільки parser smoke, не доказ channel registration. Підготовлено native session launch у Terminal, consent лишається людською дією. CUA доступ до Terminal заборонений середовищем; цей бар'єр не обходиться.

Native channel registration → nonce → acceptance → own Claude result, дві roles, review fix cycle та idle broker crash/reconnect підтверджені окремими receipts у [verification](verification.md). Project-scoped MCP config створено, `codex mcp list` бачить enabled server; global plugin installation не виконувалась. Фактичний native MCP tool call із Desktop chat ще потрібно довести. Synthetic tests і Desktop shell MCP client не замінюють цей доказ.
