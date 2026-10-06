---
name: claude-architecture
description: Отримати архітектурну консультацію від живого Claude Code через codex2claude для поточного прив'язаного проєкту.
---

Використай MCP codex2claude: bridge_status → request_architecture → wait_for_task → task_result.
Якщо handshake=false, спочатку повідом точну відсутню native дію з setup; heartbeat не доводить готовності.

Передай мету, вимоги, обмеження, питання та явний список потрібних файлів. Контекст не включає всю історію чату. Надавай новий idempotency_key для нової задачі; повтор того самого запиту використовує той самий ключ. Немає API fallback.

Architecture є консультацією без зміни файлів або запуску тестів Claude за замовчуванням. Звичайні native permissions діють незалежно від prompt. Codex реалізує рішення у своєму дозволеному scope.

Читай receipts: queued, transport-written, accepted і completed різні. Не називай результат власною відповіддю Claude до submit_result. Очікуй максимум 25 секунд одним викликом. Якщо callback route явно погоджений і enabled, передай його exact UUID у originating_chat та notify_on_completion:true. Інакше після завершення turn потрібен manual resume/status. Після actual incoming callback перевір binding/result digest і лише тоді acknowledge_callback з exact task/snapshot/thread/nonce. Queue receipt не є actual delivery; не ack на підставі store/status. Uncertain callback не повторювати автоматично. Failed/late/cancel задачі потребують manual status у цьому MVP.

За needs_human чи delivery_uncertain поясни blocker. Перед reconcile_delivery перевір фактичний стан у native Claude; не пересилай у нову сесію навмання. Пізній результат не є своєчасним завершенням. Отримана консультація не дозволяє commit/push/publish.
