# Changelog

## Unreleased

## 0.1.3 — 2026-11-24

### Changed

- A finished turn is announced only once the agent is idle. While the harness
  still has work queued for the same run — a continuation, a goal round, a
  tool-jobs wake, a teammate's report — the message waits instead of describing
  a task that is not over.

### Fixed

- A markdown table reached the chat as raw pipe source in a code block, so the
  columns never lined up. A table is now a grid: pipes are dropped, columns are
  padded by display width (Cyrillic and CJK included), a cell wider than its
  column is cut with an ellipsis, and a long table is split into blocks that
  repeat the header.

## 0.1.2 — 2026-11-24

### Added

- `notifyBackground` (off by default) and a **Background runs** toggle on the
  Settings page: scheduled or unattended runs report their result when it is
  on. With it off, a polling task that finds nothing new no longer sends a
  message after every check — questions and approvals still do.

### Changed

- A task is announced once, when the run goes quiet, instead of a message per
  turn. A follow-up turn of the same run (auto-continuation, a queued
  follow-up, a report from a teammate) cancels the pending message and the
  last answer is what the chat receives. While subagents — an agent team, a
  delegated child — are still working, the message waits for them, so a
  running team does not narrate each captain turn.
- The completion message carries the agent's final answer in full, with its
  Markdown rendered: paragraphs, lists, tables and fenced code keep the shape
  they have in the DSH transcript. An answer with no text sends nothing.
- The `Turn complete` heading and the echoed user prompt are gone; a single
  `✅ workspace — title` line gives the context above the answer.
- Long messages are converted to HTML first and then split, so a code block,
  a bold span or a link that crosses a message boundary is closed and
  reopened instead of reaching the chat broken. Question and plan prompts
  split the same way, with their buttons on the last part.
- A plan review carries the whole plan (up to the notification cap) instead of
  stopping at 1500 characters; other question detail keeps up to 3000.

### Fixed

- A finished task used to send a one-line, 900-character snippet with every
  newline collapsed, so the chat showed neither the formatting nor the rest
  of the answer.

## 0.1.1 — 2026-11-18

### Added

- `publish.yml`: publishing to npm on `v*` tags (a published GitHub release or a
  manual dispatch does the same). The tag must name the `package.json` version,
  tests run first, and the publish uses OIDC trusted publishing with provenance.
  A tag for a version that is already on npm is a no-op, so re-tagging is safe.
- `npm run release` script (`npm test && npm publish --access public`).
- CI badge, and `package-lock.json` is committed; CI now runs `npm ci`.
- README sections **Development** and **Releasing**.
- `AGENTS.md` with the repository's development rules, including the mandatory
  changelog policy for every user-visible change.

### Changed

- Publishing documents the trusted-publisher setup end to end (`npm trust
  github …`, `npm trust list`, the 48-hour validation window) and keeps a
  granular `NPM_TOKEN` as the fallback when the OIDC exchange is refused.

- The license badge reads GitHub's license detection
  (`img.shields.io/github/license/…`) instead of `npm/l`, which kept serving a
  cached "package not found" from before the first publish. The version badge
  URL carries `cacheSeconds` so GitHub's image proxy fetches it again.

### Fixed

- Publishing from a clone without `node_modules` failed at `prepublishOnly`, which
  runs `npm test`, while the plugin imports `@deepseek-ai/schemastery`: the gate
  is now documented in **Development** and the tag workflow installs
  dependencies with `npm ci` before testing.

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
