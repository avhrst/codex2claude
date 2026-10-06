# codex2claude

Пояснення та operator docs українською. Це загальний локальний Codex/Claude міст, не Oracle APEX продукт.

Codex Desktop — виконавець, Claude Code — native architect/reviewer. Не додавати Anthropic model API, Agent SDK, credential extraction, permission bypass або UI/clipboard transport як заміну Channels. Global configuration, commit/push і publication змінювати лише в явно дозволеному scope.

Зберігати exact snapshot binding, explicit acceptance/result receipts і uncertain delivery. Heartbeat/transport write не називати native readiness/approval. Пізні результати зберігати окремо; cancellation cooperative. Desktop callback доводити саме в адресованому чаті.

`resolve-stopped` викликати лише після особистого підтвердження користувачем зупинки native сесії саме цієї задачі. Timeout/heartbeat не є таким підтвердженням. Ця CLI дія прихована з MCP tool catalog, але доступна trusted same-user процесам; окремої технічної автентифікації оператора немає.

Перевірки: `npm test`, `npm run check`; Unix IPC tests потребують звичайного локального середовища, де дозволений socket listen. Mocks не доводять native інтеграцію. Live receipts не комітити: `.codex2claude/` приватний ignored state. Поточні докази — `docs/verification.md`.
