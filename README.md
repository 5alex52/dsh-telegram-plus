# dsh-telegram-plus

[![npm](https://img.shields.io/npm/v/dsh-telegram-plus?cacheSeconds=3600)](https://www.npmjs.com/package/dsh-telegram-plus)
[![license](https://img.shields.io/github/license/5alex52/dsh-telegram-plus)](LICENSE)
[![ci](https://github.com/5alex52/dsh-telegram-plus/actions/workflows/ci.yml/badge.svg)](https://github.com/5alex52/dsh-telegram-plus/actions/workflows/ci.yml)

Telegram notifications for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
that **look like Telegram messages** — and that you can **answer without
leaving the chat**.

DeepSeek Harness renders model output as Markdown: `**bold**`, `## headings`,
fenced code, tables. The usual Telegram plugins send that text raw, so your
phone shows asterisks and backticks instead of formatting. This plugin renders
it with Telegram's own HTML subset, and goes one step further: a pending
question or a tool approval becomes a message with buttons, and your tap (or
your reply) is the answer DSH receives.

```
✅ my-project — Fix the CI pipeline

**Found it**: the cache key uses `pwd`, so every worktree misses it.

- rebuild the cache on `package-lock.json`
```

The whole answer arrives — every paragraph, list and code block, rendered
with Telegram formatting. A task that took twenty turns still sends one
message, and only when it is actually done.

## Features

| | |
| --- | --- |
| **Telegram-native formatting** | Markdown becomes `<b>`, `<i>`, `<s>`, `<code>`, `<pre>`, `<blockquote>`, `<a href>`. Every dynamic value is escaped, so model output can never inject markup. |
| **Long messages stay whole** | The rendered message is split across several messages when it exceeds Telegram's 4096-character limit — a code block or a bold span that crosses a boundary is closed and reopened instead of being cut. |
| **Never a lost message** | If Telegram rejects an entity, the message is retried once as plain text. |
| **One message per task** | The full final answer of a task you started, sent once when the run goes quiet — after any agent-team or delegated subagent work has settled. Intermediate turns are coalesced, and an answer with no text sends nothing. |
| **Quiet background** | Scheduled or unattended runs do not report every check; turn on **Background runs** to receive their results too. |
| **Failures still arrive** | Failed, blocked, max-token and cancelled turns are reported immediately, with the workspace and the reason. |
| **Plan reviews** | A plan waiting for approval arrives with the plan body. |
| **Answer questions from the chat** | A pending `ask_user_question` is posted with one inline button per option; a plain reply is taken as a free-text answer. |
| **Decide approvals from the chat** | A pending tool approval arrives with **✅ Allow once / ❌ Reject**. |
| **No duplicate prompts** | When replies are on, the plain notification is replaced by the answerable message, not added to it. |
| **Works next to the Web UI** | Telegram and the browser race for the same question; whichever answers first wins and the other prompt is withdrawn. |

## Formatting

| Markdown | Telegram |
| --- | --- |
| `**bold**`, `__bold__` | `<b>` |
| `*italic*`, `_italic_` | `<i>` |
| `~~strike~~` | `<s>` |
| `` `code` `` | `<code>` |
| ```` ```ts … ``` ```` | `<pre><code class="language-ts">` |
| `[text](https://…)` | `<a href>` |
| `> quote` | `<blockquote>` |
| `# Heading` | bold line |
| `- item`, `1. item` | `• item`, bold number |
| pipe tables | aligned columns in a `<pre>` block: pipes are dropped, columns are padded by display width, a long table is split with its header repeated |

Set `format: plain` to send raw text instead.

## Install

```bash
# from npm
dsh plugin --profile web add dsh-telegram-plus

# or straight from the repository
dsh plugin --profile web add github:5alex52/dsh-telegram-plus
```

Use `--profile desktop` for the desktop app. The package declares `dsh.bundle`,
so `dsh plugin add` mounts the `telegram-plus` row for you. Restart `dsh`, then
open **Settings → Telegram**.

1. Paste the bot token and press **Save token** — it goes to the DSH credential
   store under `TELEGRAM_BOT_TOKEN` (never into the plugin configuration).
2. Enter the chat id and press **Save settings**.
3. Pick the events you want, and keep **Reply from Telegram** on if you want to
   answer from the chat.

### Getting a bot and a chat id

Create a bot with [@BotFather](https://t.me/BotFather) and copy its token. Send
the bot any message, then ask [@userinfobot](https://t.me/userinfobot) for your
numeric id. Replies require a **private** chat: a positive numeric id. Group and
channel ids receive notifications but cannot answer, because there is no way to
verify who pressed a button there.

## Configuration

The Settings page writes the `telegram-plus` row of
`~/.dsh/profiles/<profile>/cordis.patch.yml`; the same keys work in YAML:

```yaml
- id: telegram-plus
  name: dsh-telegram-plus
  config:
    chatId: "123456789"
    tokenRef: TELEGRAM_BOT_TOKEN
    format: html          # html | plain
    allowReplies: true    # read button presses and replies
    answerTimeoutMinutes: 0
    silent: false
    notifyTurnComplete: true   # one message per task you started
    notifyBackground: false    # also report scheduled/unattended runs
    notifyTurnError: true
    notifyTurnAborted: false
    notifyQuestions: true
    notifyPlanReviews: true
    notifyApprovals: true
```

| Key | Default | Meaning |
| --- | --- | --- |
| `chatId` | `""` (disabled) | Target chat. Replies need a positive numeric id. |
| `tokenRef` | `TELEGRAM_BOT_TOKEN` | Credential reference holding the bot token. |
| `token` | unset | Literal token for one-off runs; the Settings page never writes it. |
| `apiBase` | `https://api.telegram.org` | Bot API base; change only for a local Bot API server. |
| `format` | `html` | `html` renders markdown; `plain` sends raw text. |
| `allowReplies` | `true` | Read Telegram updates and let the chat answer. |
| `answerTimeoutMinutes` | `0` | Close a Telegram prompt after N minutes; `0` waits. |
| `silent` | `false` | Send without a notification sound. |
| `notifyTurnComplete` | `true` | The final answer of a task you started, once per task. |
| `notifyBackground` | `false` | Also report scheduled/unattended runs when they finish. |
| `notifyTurnError` | `true` | Failed, blocked and max-token turns. |
| `notifyTurnAborted` | `false` | Cancelled turns. |
| `notifyQuestions` | `true` | Pending questions. |
| `notifyPlanReviews` | `true` | Plans waiting for approval. |
| `notifyApprovals` | `true` | Pending tool approvals. |

## How answering works

The Host half joins two Cordis waterfalls — `user-questions/request` and
`approval/request` — with `prepend: true`, and calls `next()` so the browser
answerer still gets the request. Both prompts race:

- the first answer wins;
- the loser is cancelled through the shared abort signal, so a question can
  never be answered twice and no stale card stays on screen;
- when no browser client is attached, the UI chain reports `unavailable` for an
  approval — the plugin keeps waiting for Telegram instead of failing the
  request closed.

A free-text reply never decides an approval: only the buttons do. For a batch of
questions, reply with one line per question, in order. Timed asks (the
`timeout` parameter of `ask_user_question`) keep the Web UI behaviour.

## Security

- Only the configured private chat may answer. Every update is checked against
  `chatId` before anything is dispatched.
- **Allow once** pressed in Telegram is a real grant. Keep the bot in a private
  chat and keep the token out of shared files; prefer the credential store over
  `token:` in YAML.
- The bot is send-and-answer only: it does not let the chat drive agents, run
  commands, or browse your sessions.
- The Telegram backlog is skipped on startup, so an old message can never answer
  a fresh question.

## Limitations

- One poller per bot. If another integration (for example `dsh-im`) starts
  polling the same token, Telegram answers `409 Conflict`; the plugin logs one
  warning and retries, and replies stay off until the other poller stops.
- Approvals and questions are answered; *starting* or steering agents from
  Telegram is out of scope.
- Group and channel chats are notification-only.

## Tests

```bash
npm test        # node --test, 33 tests, no network
```

The suite covers markdown rendering and escaping, HTML-aware message splitting, settings
resolution, delivery with the HTML→plain fallback, question and approval
buttons, free-text answers, the race against the browser answerer, and the
polling loop. Every HTTP call goes to a local Bot API stub.

## Development

```bash
npm install      # required before the first test run: the plugin imports @deepseek-ai/schemastery
npm test         # node --test, 33 tests, no network
```

`npm publish` runs `npm test` through `prepublishOnly`, so a clone without
`npm install` cannot be published — that is the intended gate. To release:

```bash
npm login          # once
npm run release    # tests, then npm publish --access public
```

## Releasing

Bump `version` in `package.json`, move `CHANGELOG.md` under the new version, commit, then tag:

```bash
git tag -a v<version> -m "dsh-telegram-plus <version>"
git push origin main --follow-tags
```

`.github/workflows/publish.yml` runs on `v*` tags (a published GitHub release,
or a manual dispatch, does the same): it checks that the tag names the
`package.json` version, runs the tests, and publishes with provenance through
OIDC trusted publishing. A tag for a version that is already on npm is a no-op,
so re-tagging is safe.

### Trusted publishing

Configure the relationship once, from a machine with your npm 2FA (npm ≥ 11.19):

```bash
npm trust github dsh-telegram-plus \
  --repository 5alex52/dsh-telegram-plus \
  --file publish.yml \
  --allow-publish
npm trust list dsh-telegram-plus   # verify what the registry stored
```

Requirements the registry checks at publish time, not at save time:

- **repository** must match `owner/repo`, and **workflow filename** must be the
  bare file name (`publish.yml`, not a path) of the workflow that runs
  `npm publish` — here `publish.yml`;
- leave **environment** empty unless the job declares one;
- a configuration that has never published expires **48 hours** after it was
  created, so create it right before the release you are testing it with: the
  first successful publish validates the binding and keeps it.

If the exchange is still refused with
`403 OIDC permission denied for this action`, check the three fields above, then
re-create the relationship (`npm trust revoke … --id=<id>`, `npm trust github …`)
and publish once to validate it. npm/cli#9969 tracks refusals for repositories
that emit GitHub's immutable OIDC subject form; when that is the cause, the
workflow's fallback below covers it.

### Fallback: granular token

The workflow publishes with OIDC when no `NPM_TOKEN` secret exists. If trusted
publishing is unavailable, add a **granular access token** (scope: this package,
read and write, 2FA bypass) as the repository secret `NPM_TOKEN`; the token step
then runs instead, provenance included. Remove the secret as soon as OIDC works
again — npm is restricting 2FA-bypass publishing tokens.

## Credits

A fork of [dsh-telegram-notify](https://github.com/RGarrido03/dsh-telegram-notify)
by Rúben Garrido (MIT). This fork adds Telegram HTML rendering, message
splitting, two-way question answers and approval buttons.

## License

MIT — see [LICENSE](LICENSE).
