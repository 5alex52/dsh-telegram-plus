# Changelog

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
