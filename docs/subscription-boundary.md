# Нативна сесія та підписка

codex2claude запускає незмінений встановлений Claude Code в інтерактивному terminal. Вхід і підписку обслуговує сам Claude Code. Наш код не читає auth stores, OAuth/session tokens чи Keychain; `doctor` викликає лише офіційну `claude auth status` і виводить sanitized статус без email/org/account identifiers.

Немає Anthropic API, Agent SDK, API key onboarding або API billing fallback. Наші runtime dependencies — офіційний MCP SDK та Zod; SDK тут реалізує протокол інструментів, а не модельне виконання. `claude-session` не застосовує `--print`, `--bare`, permission bypass чи permission relay. Native дозволи й organization policy залишаються у Claude Code.

Наш development channel потребує native consent у кожному запуску, де його вимагає Claude Code. Login не доводить доступність Channels. Team/Enterprise policy може блокувати події при працездатному MCP. Channels — research preview; Desktop Channels support не заявляється.

Це технічна межа реалізації, не сертифікація умов і не обіцянка необмеженої підписки. Перед публічними policy/billing заявами повторно звірити [чинні умови Claude Code](https://code.claude.com/docs/en/legal-and-compliance) та [Channels](https://code.claude.com/docs/en/channels).

Review/architecture prompt не є sandbox. Claude за замовчуванням проситься лише консультувати, без native code execution чи edits. Людина окремо вирішує дозволи на його хості. Codex tools/permissions автоматично не передаються.
