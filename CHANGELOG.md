# Changelog

## 0.1.0 — 2026-11-18

First public release. Fork of
[`dsh-telegram-notify`](https://github.com/RGarrido03/dsh-telegram-notify) 0.2.3.

### Added

- Telegram HTML rendering for model output: bold, italics, strikethrough, inline
  code, fenced code blocks with a language tag, links, blockquotes, headings,
  list bullets and pipe tables. Every dynamic value is escaped.
- Message splitting at line boundaries for text over Telegram's 4096-character
  limit, plus a one-shot plain-text fallback when Telegram rejects an entity.
- Answering `ask_user_question` from the chat: one inline button per option, or
  a free-text reply; multi-question prompts take one line per question.
- Answering tool approvals from the chat with **Allow once / Reject**.
- Race handling against the Web UI on both waterfalls: the first answer wins and
  the other prompt is cancelled through the shared abort signal.
- `format`, `allowReplies` and `answerTimeoutMinutes` settings, editable from the
  Settings page.
- 22 tests covering rendering, escaping, splitting, delivery, both answer paths,
  the UI race and the polling loop.

### Changed

- Plugin name, loader row and settings namespace are `telegram-plus`, so the
  plugin can be installed next to `dsh-telegram-notify`.
- Long notifications are split instead of clipped.
- Plain approval notifications are replaced by the answerable message when
  replies are on, instead of being sent twice.

### Fixed

- Raw Markdown reached the chat as literal asterisks, hashes and backticks.
- A single over-long turn summary was cut mid-word at 4096 characters.

### Notes

- Only one process may poll a bot; a second poller gets `409 Conflict`.
- Replies are accepted only from a private chat.
