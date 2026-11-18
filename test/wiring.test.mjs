import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { apply } from '../lib/index.js'

const silentLogger = { warn() { }, info() { }, debug() { } }

/** Bot API stand-in: records calls, serves a getUpdates queue, skips the backlog. */
async function startFakeBot() {
  const calls = []
  const updates = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const method = new URL(req.url, 'http://127.0.0.1').pathname.split('/').pop()
    const payload = raw === '' ? {} : JSON.parse(raw)
    calls.push({ method, payload })
    let result = true
    if (method === 'sendMessage')
      result = { message_id: 500 + calls.length }
    if (method === 'getUpdates') {
      if (payload.offset === -1 || updates.length === 0) {
        // Emulate a long poll so the loop does not spin the event loop.
        if (payload.offset !== -1)
          await new Promise((resolve) => setTimeout(resolve, 10))
        result = []
      }
      else {
        result = [updates.shift()]
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, result }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    calls,
    updates,
    methods: (name) => calls.filter((call) => call.method === name),
    close: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** Minimal Cordis stand-in that records handlers and runs effects. */
function fakeContext() {
  const handlers = new Map()
  const effects = []
  return {
    ctx: {
      logger: () => silentLogger,
      inject(names, callback) {
        // No `settings` service in this harness: the auto form stays hidden.
        if (names.includes('settings'))
          return
        callback(this)
      },
      effect(factory) {
        effects.push(factory())
        return () => { }
      },
      on(event, handler) {
        const list = handlers.get(event) ?? []
        list.push(handler)
        handlers.set(event, list)
        return () => { }
      },
      credentials: { async resolve() { return { value: '123456:AAexample-token-value' } } },
    },
    handlers,
    emit(event, ...args) {
      for (const handler of handlers.get(event) ?? [])
        void handler(...args)
    },
    dispose() {
      for (const effect of effects.reverse())
        effect?.()
    },
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('wiring: completed turn is pushed as formatted HTML', async () => {
  const bot = await startFakeBot()
  const harness = fakeContext()
  try {
    apply(harness.ctx, { chatId: '4242', token: '123456:AAexample-token-value', apiBase: bot.base, answerTimeoutMinutes: 0 })
    harness.emit('session/event', { header: { cwd: '/Users/mac/dev/project' } }, {
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
    await wait(250)
    const sent = bot.methods('sendMessage')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].payload.parse_mode, 'HTML')
    assert.match(sent[0].payload.text, /<b>Turn complete<\/b>/)
  }
  finally {
    harness.dispose()
    await bot.close()
  }
})

test('wiring: a pending question is posted with buttons and answered from Telegram', async () => {
  const bot = await startFakeBot()
  const harness = fakeContext()
  try {
    apply(harness.ctx, { chatId: '4242', token: '123456:AAexample-token-value', apiBase: bot.base, answerTimeoutMinutes: 0 })
    await wait(40)
    // The browser answerer: stays pending until the shared signal aborts.
    const uiBranch = (request) => new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('ui branch cancelled')), { once: true })
    })
    const request = {
      agent: { session: { header: { cwd: '/Users/mac/dev/project' } } },
      questions: [{ id: 'q1', header: 'Format', question: 'Which formatting?', options: [{ label: 'HTML' }, { label: 'Plain' }] }],
    }
    const handler = harness.handlers.get('user-questions/request')[0]
    const pending = handler(request, () => uiBranch(request))
    await wait(250)
    const prompt = bot.methods('sendMessage')[0]
    assert.ok(prompt, 'the question prompt should be sent')
    assert.equal(prompt.payload.reply_markup.inline_keyboard.length, 2)
    const button = prompt.payload.reply_markup.inline_keyboard[0][0]
    assert.equal(button.text, 'HTML')
    // Deliver the press through getUpdates, exactly like a real poll cycle.
    bot.updates.push({
      update_id: 42,
      callback_query: {
        id: 'cb42',
        from: { id: 4242 },
        message: { message_id: prompt.payload.message_id ?? 501, chat: { id: 4242 } },
        data: button.callback_data,
      },
    })
    const answer = await pending
    assert.deepEqual(answer.answers, [{ id: 'q1', selected: ['HTML'] }])
    assert.equal(request.signal.aborted, true, 'the UI branch must be cancelled once Telegram answers')
    await wait(60)
    assert.equal(bot.methods('editMessageText').length, 1)
  }
  finally {
    harness.dispose()
    await bot.close()
  }
})

test('wiring: ask_user_question does not also send a plain notification', async () => {
  const bot = await startFakeBot()
  const harness = fakeContext()
  try {
    apply(harness.ctx, { chatId: '4242', token: '123456:AAexample-token-value', apiBase: bot.base })
    harness.emit('session/event', { header: { cwd: '/Users/mac/dev/project' } }, {
      type: 'tool/call',
      data: {
        callId: 'call-1',
        name: 'ask_user_question',
        arguments: JSON.stringify({ questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'A' }] }] }),
      },
    })
    await wait(80)
    assert.equal(bot.methods('sendMessage').length, 0)
  }
  finally {
    harness.dispose()
    await bot.close()
  }
})

test('wiring: an answer in the DSH UI wins and closes the Telegram prompt', async () => {
  const bot = await startFakeBot()
  const harness = fakeContext()
  try {
    apply(harness.ctx, { chatId: '4242', token: '123456:AAexample-token-value', apiBase: bot.base, answerTimeoutMinutes: 0 })
    await wait(40)
    const request = {
      agent: { session: { header: { cwd: '/Users/mac/dev/project' } } },
      questions: [{ id: 'q1', question: 'Which formatting?', options: [{ label: 'HTML' }, { label: 'Plain' }] }],
    }
    const uiAnswer = { answers: [{ id: 'q1', selected: ['Plain'] }] }
    const handler = harness.handlers.get('user-questions/request')[0]
    const answer = await handler(request, async () => uiAnswer)
    assert.deepEqual(answer, uiAnswer)
    await wait(120)
    assert.equal(bot.methods('sendMessage').length, 1, 'the prompt is still posted')
    const edit = bot.methods('editMessageText')[0]
    assert.ok(edit, 'the prompt should be closed')
    assert.match(edit.payload.text, /Answered in the DSH UI\./)
    assert.deepEqual(edit.payload.reply_markup, { inline_keyboard: [] })
  }
  finally {
    harness.dispose()
    await bot.close()
  }
})

test('wiring: an approval is posted with buttons and answered from Telegram', async () => {
  const bot = await startFakeBot()
  const harness = fakeContext()
  try {
    apply(harness.ctx, { chatId: '4242', token: '123456:AAexample-token-value', apiBase: bot.base })
    await wait(40)
    const request = {
      agent: { session: { header: { cwd: '/Users/mac/dev/project' } } },
      toolName: 'bash',
      reason: 'write outside the workspace',
    }
    const handler = harness.handlers.get('approval/request')[0]
    const pending = handler(request, () => 'unavailable')
    await wait(250)
    const prompt = bot.methods('sendMessage')[0]
    assert.ok(prompt, 'the approval prompt should be sent')
    assert.equal(prompt.payload.reply_markup.inline_keyboard.flat().length, 2)
    bot.updates.push({
      update_id: 77,
      callback_query: {
        id: 'cb77',
        from: { id: 4242 },
        message: { message_id: prompt.payload.message_id, chat: { id: 4242 } },
        data: prompt.payload.reply_markup.inline_keyboard.flat()[0].callback_data,
      },
    })
    assert.equal(await pending, 'allowed-once')
    await wait(80)
    assert.match(bot.methods('editMessageText')[0].payload.text, /Allowed once from Telegram\./)
  }
  finally {
    harness.dispose()
    await bot.close()
  }
})

test('wiring: an approval answered in the DSH UI closes the Telegram prompt', async () => {
  const bot = await startFakeBot()
  const harness = fakeContext()
  try {
    apply(harness.ctx, { chatId: '4242', token: '123456:AAexample-token-value', apiBase: bot.base })
    await wait(40)
    const request = {
      agent: { session: { header: { cwd: '/Users/mac/dev/project' } } },
      toolName: 'bash',
      reason: 'needs a decision',
    }
    const handler = harness.handlers.get('approval/request')[0]
    const answer = await handler(request, async () => 'rejected')
    assert.equal(answer, 'rejected')
    await wait(120)
    assert.equal(bot.methods('sendMessage').length, 1, 'the prompt is still posted')
    assert.match(bot.methods('editMessageText')[0].payload.text, /Decided in the DSH UI\./)
  }
  finally {
    harness.dispose()
    await bot.close()
  }
})
