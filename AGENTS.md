# AGENTS.md

Rules for changing this repository. Read this before editing anything.

## What this is

A Cordis plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
it pushes turns, errors, questions, plan reviews and tool approvals to a Telegram
chat with Telegram-native formatting, and answers questions and approvals from
that chat. A fork of
[`dsh-telegram-notify`](https://github.com/RGarrido03/dsh-telegram-notify) (MIT) —
keep that attribution in `LICENSE`, `README.md` and `CHANGELOG.md`.

Published as the npm package `dsh-telegram-plus`; the loader row, settings
namespace and client bundle id are all `telegram-plus`.

## Layout

| Path | Role |
| --- | --- |
| `lib/index.js` | Host half: session events, formatting, Bot API client, question/approval waterfalls, `getUpdates` poller. |
| `lib/client.js` | Browser half: the **Settings → Telegram** page. A classic module-loader script, not an ES module — it calls `window.__ModuleLoader__.load` and gets React through `require`. |
| `locale/en.json` | Settings-page metadata. |
| `cordis.patch.yml` | Bundle patch that inserts the `telegram-plus` row. |
| `test/*.test.mjs` | `node:test` suites; every HTTP call goes to a local Bot API stub. |
| `.github/workflows/` | `ci.yml` (push, PR) and `publish.yml` (tags, releases). |

## Non-negotiables

1. **Every user-visible change updates `CHANGELOG.md`.** Add a bullet under
   `## Unreleased` using the Keep a Changelog headings (`Added`, `Changed`,
   `Fixed`, `Deprecated`, `Removed`, `Security`). When releasing, move those
   bullets into a `## <version> — <date>` section **in the same commit as the
   version bump**; a release tag without its changelog section is a bug. Write
   what a user notices and why it matters, not which files moved.
2. **A behavior change without a test is incomplete.** Extend
   `test/plugin.test.mjs` (unit: rendering, splitting, settings, delivery) or
   `test/wiring.test.mjs` (integration: `apply`, waterfalls, poller). Tests must
   never reach the real Telegram API — use the local stub.
3. **Never put model text into HTML unescaped.** Route dynamic content through
   `toTelegramHtml` / `inlineToHtml` / `escapeXml`; a rejection from Telegram must
   stay recoverable through the plain-text fallback.
4. **Secrets stay out of logs and errors.** The bot token and the endpoint that
   carries it must never appear in a log line, an error message or a test
   snapshot. Tests use literal dummy tokens.
5. **Keep the answer race intact.** Both waterfalls register with
   `prepend: true`, call `next()` so the Web UI still sees the request, and abort
   the losing branch through the shared signal. A question must never be
   answerable twice. Only a positive numeric (private) `chatId` may answer;
   approvals are decided by buttons only, never by a text message.
6. **One identity everywhere.** `telegram-plus` is the loader row id in
   `cordis.patch.yml`, the settings namespace in `lib/client.js`
   (`SETTINGS_NS`), the exported plugin `name`, and the client bundle id. Rename
   all of them together or the Settings page reports the namespace as
   unavailable.
7. **Read config at use time.** Config fields are schemastery `volatile` fields:
   read them through `readSettings()` inside the handler, never snapshot them in
   `apply`.
8. **Respect Telegram limits.** 4096 characters per message (split at line
   boundaries), 64 bytes of `callback_data` (short prompt ids), `sendMessage`
   text is HTML.
9. **Ship only what is needed.** `files` in `package.json` decides the tarball;
   tests, CI and this file stay out. Add a shipped file to `files` in the same
   change.

## Working on the plugin

```bash
npm install      # required once: lib/index.js imports @deepseek-ai/schemastery
npm test         # node --test, no network
```

- Keep the code dependency-free beyond `@deepseek-ai/schemastery`; the plugin
  runs inside the harness process.
- `lib/client.js` cannot use `import`/`export` — the loader evaluates it as a
  module-loader script. Locales are dictionaries inside the factory.
- Coalesce notifications: when replies are enabled, the answerable message
  replaces the plain notification instead of duplicating it.
- Prefer a local install when testing against a real harness:
  `dsh plugin --profile web add file:$PWD/$(npm pack --pack-destination /tmp | tail -1)`
  (a local directory install symlinks the source and cannot resolve
  `@deepseek-ai/schemastery`; the tarball behaves like the published package).

## Releasing

1. Bump `version` in `package.json` and move the `## Unreleased` bullets into a
   matching `## <version> — <date>` section.
2. Commit, then tag: `git tag -a v<version> -m "dsh-telegram-plus <version>"`.
3. `git push origin main --follow-tags`.

`.github/workflows/publish.yml` runs on `v*` tags (also on a published GitHub
release or a manual dispatch): it fails when the tag and `package.json` version
differ, runs the tests, and publishes with provenance through OIDC trusted
publishing. A version that is already on npm is skipped, so re-tagging is safe.
Trusted publishing is configured once with
`npm trust github dsh-telegram-plus --repository 5alex52/dsh-telegram-plus
--file publish.yml --allow-publish`, and `npm trust list` shows what the registry
stored. An unpublished configuration expires 48 hours after creation, so create
it shortly before a release and let the first publish validate it. A package
scoped granular token in `NPM_TOKEN` is only the fallback for when the OIDC
exchange is refused; the workflow prefers a token when one is set.

## Commits and docs

- Commit subjects: `feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:` plus an
  imperative summary; explain the *why* in the body when behavior, compatibility
  or the release process changes.
- `README.md` and `README.ru.md` both describe user-facing behavior. Change them
  together; the Russian file is a full translation, not a summary.
- Process-only edits (CI, this file) need a changelog line only when they change
  what contributors or users must do.
