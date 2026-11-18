import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  createApi,
  createBroker,
  escapeXml,
  formatCompleted,
  formatQuestions,
  inlineToHtml,
  resolveSettings,
  splitForTelegram,
  startPoller,
  toTelegramHtml,
} from '../lib/index.js'

const session = { header: { cwd: '/Users/mac/dev/project' } }
const state = { title: 'Fix the telegram formatting', user: 'Переделай формат', assistant: '' }

/** Start a Bot API stand-in that records calls and replays queued replies. */
async function startFakeBot() {
  const calls = []
  const queued = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const method = new URL(req.url, 'http://127.0.0.1').pathname.split('/').pop()
    const payload = raw === '' ? {} : JSON.parse(raw)
    calls.push({ method, payload })
    const scripted = queued.shift()
    if (scripted !== undefined) {
      res.writeHead(scripted.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(scripted.body))
      return
    }
    const result = method === 'sendMessage' ? { message_id: 1000 + calls.length } : true
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, result }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    calls,
    queued,
    close: async () => {
      // Let fire-and-forget edits land before the listener goes away.
      await new Promise((resolve) => setTimeout(resolve, 25))
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
    methods: (name) => calls.filter((call) => call.method === name),
  }
}

function makeSettings(base, overrides = {}) {
  const settings = resolveSettings({
    chatId: '4242',
    token: '123456:AAexample-token-value',
    apiBase: base,
    ...overrides,
  })
  assert.ok(settings, 'settings should resolve')
  return settings
}

const silentLogger = { warn() { }, info() { }, debug() { } }

test('renders markdown as Telegram HTML', () => {
  assert.equal(toTelegramHtml('**bold** and _italic_ and ~~gone~~'), '<b>bold</b> and <i>italic</i> and <s>gone</s>')
  assert.equal(toTelegramHtml('## Heading'), '<b>Heading</b>')
  assert.equal(toTelegramHtml('- one\n- two'), '• one\n• two')
  assert.equal(toTelegramHtml('1. first\n2. second'), '<b>1.</b> first\n<b>2.</b> second')
  assert.equal(toTelegramHtml('use `npm test` now'), 'use <code>npm test</code> now')
  assert.equal(toTelegramHtml('[docs](https://example.com/a?b=1&c=2)'), '<a href="https://example.com/a?b=1&amp;c=2">docs</a>')
  assert.equal(toTelegramHtml('> quoted **text**'), '<blockquote>quoted <b>text</b></blockquote>')
})

test('escapes every value and keeps code literal', () => {
  assert.equal(escapeXml('a < b & c > d'), 'a &lt; b &amp; c &gt; d')
  assert.equal(toTelegramHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;')
  assert.equal(toTelegramHtml('`**not bold**`'), '<code>**not bold**</code>')
  assert.equal(
    toTelegramHtml('```ts\nconst a = 1 < 2 && b\n```'),
    '<pre><code class="language-ts">const a = 1 &lt; 2 &amp;&amp; b</code></pre>',
  )
  assert.equal(toTelegramHtml('| a | b |\n| - | - |'), '<pre>| a | b |\n| - | - |</pre>')
})

test('keeps emphasis out of already escaped text', () => {
  assert.equal(inlineToHtml('a *b* c'), 'a <i>b</i> c')
  assert.equal(inlineToHtml('2 * 3 * 4'), '2 * 3 * 4')
})

test('splits long text on line boundaries without losing content', () => {
  const line = 'x'.repeat(90)
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index} ${line}`)
  const source = lines.join('\n')
  const parts = splitForTelegram(source, 300)
  assert.ok(parts.length > 1)
  assert.ok(parts.every((part) => part.length <= 300))
  assert.equal(parts.join('\n'), source)
  assert.deepEqual(splitForTelegram('short'), ['short'])
  const longLine = 'y'.repeat(700)
  const hard = splitForTelegram(longLine, 300)
  assert.equal(hard.join(''), longLine)
})

test('resolves settings with reply defaults', () => {
  const settings = resolveSettings({ chatId: '1', token: 'x:y' })
  assert.equal(settings.allowReplies, true)
  assert.equal(settings.format, 'html')
  assert.equal(settings.answerTimeoutMinutes, 0)
  assert.equal(resolveSettings({ token: 'x:y', format: 'plain' }).format, 'plain')
  assert.equal(resolveSettings({ token: 'x:y', allowReplies: false }).allowReplies, false)
  assert.equal(resolveSettings({ chatId: '1', token: 'x:y', answerTimeoutMinutes: -3 }).answerTimeoutMinutes, 0)
  assert.equal(resolveSettings({ apiBase: 'ftp://nope' }), undefined)
  assert.equal(resolveSettings({ tokenRef: 'bad ref!' }), undefined)
  assert.ok(resolveSettings({ token: 'x:y', tokenRef: 'bad ref!' }))
})

test('formats a completed turn as markdown that converts to HTML', () => {
  const markdown = formatCompleted(session, { ...state, assistant: '**Done**: sent 3 messages' })
  const html = toTelegramHtml(markdown)
  assert.match(html, /<b>Turn complete<\/b>/)
  assert.match(html, /<b>Done<\/b>: sent 3 messages/)
  assert.match(html, /📁 project — Fix the telegram formatting/)
})

test('formats questions with options', () => {
  const html = toTelegramHtml(formatQuestions(session, state, [
    { id: 'q1', header: 'Choose', question: 'Which formatting?', options: [{ label: 'HTML' }, { label: 'Plain' }] },
  ]))
  assert.match(html, /<b>Waiting for your input<\/b>/)
  assert.match(html, /<b>Choose<\/b>/)
  assert.match(html, /• HTML/)
})

test('sends HTML and falls back to plain text when Telegram rejects entities', async () => {
  const bot = await startFakeBot()
  try {
    const settings = makeSettings(bot.base)
    const api = createApi({ ctx: {}, readSettings: () => settings, logger: silentLogger })
    bot.queued.push({ status: 400, body: { ok: false, description: 'Bad Request: can\'t parse entities' } })
    await api.sendMessage({ text: '<b>hello</b>', parseMode: 'HTML' })
    const [first, second] = bot.methods('sendMessage')
    assert.equal(first.payload.parse_mode, 'HTML')
    assert.equal(second.payload.parse_mode, undefined)
    assert.equal(second.payload.text, 'hello')
  }
  finally {
    await bot.close()
  }
})

test('answers a question from a button press', async () => {
  const bot = await startFakeBot()
  try {
    const settings = makeSettings(bot.base)
    const api = createApi({ ctx: {}, readSettings: () => settings, logger: silentLogger })
    const broker = createBroker({ readSettings: () => settings, logger: silentLogger, api, stateFor: () => state })
    const lifetime = new AbortController()
    const delivered = await broker.ask({
      agent: { session },
      questions: [{ id: 'q1', question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    }, lifetime.signal)
    assert.equal(delivered.delivered, true)
    const sent = bot.methods('sendMessage')[0]
    assert.equal(sent.payload.parse_mode, 'HTML')
    assert.equal(sent.payload.reply_markup.inline_keyboard.length, 2)
    const button = sent.payload.reply_markup.inline_keyboard[0][0]
    assert.equal(button.text, 'Yes')

    await broker.handleUpdate({
      update_id: 7,
      callback_query: {
        id: 'cb1',
        from: { id: 4242 },
        message: { message_id: sent.payload.message_id, chat: { id: 4242 } },
        data: button.callback_data,
      },
    }, settings)

    const answer = await delivered.promise
    assert.deepEqual(answer.answers, [{ id: 'q1', selected: ['Yes'] }])
    const edits = bot.methods('editMessageText')
    assert.equal(edits.length, 1)
    assert.deepEqual(edits[0].payload.reply_markup, { inline_keyboard: [] })
    assert.match(edits[0].payload.text, /Answered from Telegram\./)
    const acks = bot.methods('answerCallbackQuery')
    assert.equal(acks[0].payload.text, 'Answer sent to DSH.')
  }
  finally {
    await bot.close()
  }
})

test('answers a question from a free-text reply', async () => {
  const bot = await startFakeBot()
  try {
    const settings = makeSettings(bot.base)
    const api = createApi({ ctx: {}, readSettings: () => settings, logger: silentLogger })
    const broker = createBroker({ readSettings: () => settings, logger: silentLogger, api, stateFor: () => state })
    const lifetime = new AbortController()
    const delivered = await broker.ask({
      agent: { session },
      questions: [{ id: 'q1', question: 'Which branch?' }],
    }, lifetime.signal)
    await broker.handleUpdate({
      update_id: 8,
      message: { message_id: 5, from: { id: 4242, is_bot: false }, chat: { id: 4242, type: 'private' }, text: 'feature/telegram-format' },
    }, settings)
    const answer = await delivered.promise
    assert.deepEqual(answer.answers, [{ id: 'q1', selected: [], custom: 'feature/telegram-format' }])
  }
  finally {
    await bot.close()
  }
})

test('rejects an answer from a foreign chat and a stale button', async () => {
  const bot = await startFakeBot()
  try {
    const settings = makeSettings(bot.base)
    const api = createApi({ ctx: {}, readSettings: () => settings, logger: silentLogger })
    const broker = createBroker({ readSettings: () => settings, logger: silentLogger, api, stateFor: () => state })
    await broker.handleUpdate({
      update_id: 9,
      callback_query: { id: 'cb9', from: { id: 999 }, message: { chat: { id: 999 } }, data: 'q1:0:0' },
    }, settings)
    assert.equal(bot.methods('answerCallbackQuery')[0].payload.show_alert, true)

    const stale = await broker.handleUpdate({
      update_id: 10,
      callback_query: { id: 'cb10', from: { id: 4242 }, message: { chat: { id: 4242 } }, data: 'qzz:0:0' },
    }, settings)
    assert.equal(stale, undefined)
    assert.equal(bot.methods('answerCallbackQuery')[1].payload.text, 'This question is no longer active.')
  }
  finally {
    await bot.close()
  }
})

test('closes the prompt when the DSH UI answers first', async () => {
  const bot = await startFakeBot()
  try {
    const settings = makeSettings(bot.base)
    const api = createApi({ ctx: {}, readSettings: () => settings, logger: silentLogger })
    const broker = createBroker({ readSettings: () => settings, logger: silentLogger, api, stateFor: () => state })
    const lifetime = new AbortController()
    const delivered = await broker.ask({
      agent: { session },
      questions: [{ id: 'q1', question: 'Continue?', options: [{ label: 'Yes' }] }],
    }, lifetime.signal)
    delivered.promise.catch(() => { })
    broker.close(delivered.promptId, 'Answered in the DSH UI.')
    await assert.rejects(delivered.promise, /answered in the DSH UI/)
    assert.equal(broker.pending.size, 0)
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.match(bot.methods('editMessageText')[0].payload.text, /Answered in the DSH UI\./)
  }
  finally {
    await bot.close()
  }
})

test('polls for replies and skips the backlog first', async () => {
  const seen = []
  const api = {
    async getUpdates({ offset, timeout }) {
      seen.push({ offset, timeout })
      // Yield a macrotask so the poll loop cannot starve the test's timer.
      await new Promise((resolve) => setTimeout(resolve, 1))
      return []
    },
  }
  const settings = makeSettings('http://127.0.0.1:1')
  const broker = { async handleUpdate() { } }
  const stop = startPoller({ readSettings: () => settings, logger: silentLogger, api, broker })
  await new Promise((resolve) => setTimeout(resolve, 50))
  stop()
  assert.equal(seen[0].offset, -1)
  assert.equal(seen[0].timeout, 0)
  assert.ok(seen.length > 1)
})

test('does not poll when replies are disabled', async () => {
  let calls = 0
  const api = {
    async getUpdates() {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 1))
      return []
    },
  }
  const settings = makeSettings('http://127.0.0.1:1', { allowReplies: false })
  const broker = { async handleUpdate() { } }
  const stop = startPoller({ readSettings: () => settings, logger: silentLogger, api, broker })
  await new Promise((resolve) => setTimeout(resolve, 30))
  stop()
  assert.equal(calls, 0)
})

test('answers an approval from a button press', async () => {
  const bot = await startFakeBot()
  try {
    const settings = makeSettings(bot.base)
    const api = createApi({ ctx: {}, readSettings: () => settings, logger: silentLogger })
    const broker = createBroker({ readSettings: () => settings, logger: silentLogger, api, stateFor: () => state })
    const lifetime = new AbortController()
    const delivered = await broker.askApproval({
      agent: { session },
      toolName: 'bash',
      reason: 'run outside the workspace',
    }, lifetime.signal)
    assert.equal(delivered.delivered, true)
    const sent = bot.methods('sendMessage')[0]
    assert.match(sent.payload.text, /Approval needed/)
    const [allow, reject] = sent.payload.reply_markup.inline_keyboard.flat()
    assert.equal(allow.text, '✅ Allow once')
    assert.equal(reject.text, '❌ Reject')

    await broker.handleUpdate({
      update_id: 11,
      callback_query: {
        id: 'cb11',
        from: { id: 4242 },
        message: { message_id: sent.payload.message_id, chat: { id: 4242 } },
        data: allow.callback_data,
      },
    }, settings)

    assert.equal(await delivered.promise, 'allowed-once')
    assert.match(bot.methods('editMessageText')[0].payload.text, /Allowed once from Telegram\./)
    assert.equal(bot.methods('answerCallbackQuery')[0].payload.text, 'Decision sent to DSH.')
  }
  finally {
    await bot.close()
  }
})

test('rejects an approval and ignores a stray text message', async () => {
  const bot = await startFakeBot()
  try {
    const settings = makeSettings(bot.base)
    const api = createApi({ ctx: {}, readSettings: () => settings, logger: silentLogger })
    const broker = createBroker({ readSettings: () => settings, logger: silentLogger, api, stateFor: () => state })
    const lifetime = new AbortController()
    const delivered = await broker.askApproval({ agent: { session }, toolName: 'bash' }, lifetime.signal)
    const sent = bot.methods('sendMessage')[0]
    await broker.handleUpdate({
      update_id: 12,
      message: { message_id: 9, from: { id: 4242, is_bot: false }, chat: { id: 4242, type: 'private' }, text: 'allow' },
    }, settings)
    assert.equal(broker.pending.size, 1, 'a text message must not decide an approval')
    await broker.handleUpdate({
      update_id: 13,
      callback_query: {
        id: 'cb13',
        from: { id: 4242 },
        message: { message_id: sent.payload.message_id, chat: { id: 4242 } },
        data: sent.payload.reply_markup.inline_keyboard.flat()[1].callback_data,
      },
    }, settings)
    assert.equal(await delivered.promise, 'rejected')
    assert.match(bot.methods('editMessageText')[0].payload.text, /Rejected from Telegram\./)
  }
  finally {
    await bot.close()
  }
})
