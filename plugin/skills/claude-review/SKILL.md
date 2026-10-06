---
name: claude-review
description: Отримати рев'ю точних байтів локальних змін від живої Claude Code сесії через codex2claude.
---

Перевір bridge_status і визнач явний scope. request_review включає goal, scope, files, questions і validation з реально виконаними перевірками. Для base/head comparison передай base Git ref та явні файли; джерело head — поточні байти worktree на момент capture. CLI не припускає clean commit.

Tracked, untracked і deleted файли включаються тільки явними шляхами; binary, symlink, secret paths, понад 128 KiB/file або 1 MiB контексту відхиляються. Broker зберігає повні current/base UTF-8 bytes і SHA-256; Claude читає snapshot через task_context. Scope поза manifest не вважай переглянутим.

Дочекайся accept_task і submit_result через bounded wait_for_task/task_result. Receipt доставки не є схваленням. Перевір examined/skipped, findings, verdict, limitations і late. Перед застосуванням висновку виклич check_snapshot; matches=false означає нове рев'ю для нових байтів.

Codex виправляє findings і створює новий idempotency_key/snapshot із parent_task_id. Максимум три задачі в одному циклі; далі звернися до користувача. Claude не запускає код/тести та не змінює файли без окремої людської авторизації через native permissions. Prompt не є sandbox.

За uncertain delivery не роби retry без native reconciliation. cancel_requested — cooperative, не гарантія зупинки. Якщо callback route явно погоджений і enabled, передай його exact UUID у originating_chat та notify_on_completion:true; інакше після turn потрібен manual resume/status. Після actual incoming callback перевір binding, task_result digest/late та snapshot applicability, потім acknowledge_callback з exact task/snapshot/thread/nonce. Queue receipt або store/status не є actual delivery; uncertain callback не повторювати автоматично. Failed/late/cancel задачі потребують manual status у цьому MVP. Рев'ю та callback не дають дозволу на commit/push/merge/publish.
