# Capability gate — 6 жовтня 2026

Підтверджено read-only:

- Repository `/Users/oleksii/Code/codex2claude` початково порожній; main без commits, origin `avhrst/codex2claude`. Commit/push не виконуються.
- Node 25.9.0, npm 11.12.1, Claude Code 2.1.291, Codex CLI 0.160.0.
- Native `claude auth status` поза sandbox: loggedIn=true, authMethod=claude.ai, first-party provider, Max subscription. Усередині sandbox loggedIn=false; це не доказ відсутності login. Жодні auth files/Keychain contents не читались.
- `codex queue --help`: є команда для existing session. Реальне повернення саме у вихідний Desktop chat не перевірено.
- SDK 1.32.1, Zod 4.6.5, TypeScript 7.0.2, Node types 26.6.4 перевірені в npm і закріплені lockfile. Для продукту мінімум Node 22; реально протестовано тільки installed Node 25.9.0.

Рішення за [офіційним Codex plugin contract](https://developers.openai.com/plugins/build/plugins): portable `plugin.json`, `mcp.json` із STDIO, skills; compatibility overlay `.codex-plugin/plugin.json` і `.mcp.json`; local marketplace, без hosted endpoint. `init` генерує host-specific абсолютні runtime paths тільки в ignored state directory.

[Claude Channels reference](https://code.claude.com/docs/en/channels-reference) визначає `experimental['claude/channel']`, `notifications/claude/channel`, string metadata, інтерактивний development flag та explicit reply tools. Transport write не є native acknowledgment. Наш readiness потребує nonce tool call; acceptance/result також explicit.

Development flag із `--help` дає exit 0; це тільки parser smoke, не доказ channel registration. Підготовлено native session launch у Terminal, consent лишається людською дією. CUA доступ до Terminal заборонений середовищем; цей бар'єр не обходиться.

Потрібно довести в real apps: native channel registration → nonce tool → task event → acceptance → own Claude result → Codex Desktop MCP read. Дві roles, review fix cycle, negative/reconnect tests у native session та Desktop install ще потребують окремих receipts. Поточні локальні synthetic MCP tests не замінюють ці докази.
