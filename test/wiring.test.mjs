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
function fakeContext(services = {}) {
  const handlers = new Map()
  const effects = []
  return {
    ctx: {
      logger: () => silentLogger,
      get: (name) => services[name],
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

const rootSession = () => ({ header: { cwd: '/Users/mac/dev/project' } })

/** Play one completed turn through the session-event handlers. */
function emitTurn(harness, session, { text, source = 'user', user = 'fix the build' } = {}) {
  harness.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  harness.emit('session/event', session, {
    type: 'user/message',
    data: { source: { kind: source }, content: [{ type: 'text', text: user }] },
  })
  harness.emit('session/event', session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  })
  harness.emit('session/event', session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
}

test('wiring: a finished task is pushed once, with the whole formatted answer', async () => {
  const bot = await startFakeBot()
  const harness = fakeContext()
  try {
    apply(harness.ctx, { chatId: '4242', token: '123456:AAexample-token-value', apiBase: bot.base, answerTimeoutMinutes: 0 })
    emitTurn(harness, rootSession(), { text: '## Done\n\n- one\n- two' })
    await wait(300)
    assert.equal(bot.methods('sendMessage').length, 0, 'the quiet window comes first')
    await wait(2100)
    const sent = bot.methods('sendMessage')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].payload.parse_mode, 'HTML')
    assert.match(sent[0].payload.text, /✅ project/)
    assert.match(sent[0].payload.text, /<b>Done<\/b>/)
    assert.match(sent[0].payload.text, /• one\n• two/)
    assert.doesNotMatch(sent[0].payload.text, /Turn complete/)
  }
  finally {
    harness.dispose()
    await bot.close()
  }
})

test('wiring: a long answer arrives whole across several HTML messages', async () => {
  const bot = await startFakeBot()
  const harness = fakeContext()
  try {
    apply(harness.ctx, { chatId: '4242', token: '123456:AAexample-token-value', apiBase: bot.base })
    const answer = Array.from({ length: 120 }, (_, index) => '- step ' + index + ': **done** with \u0060item-' + index + '\u0060').join('\n')
    emitTurn(harness, rootSession(), { text: answer })
    await wait(2300)
    const sent = bot.methods('sendMessage')
    assert.ok(sent.length > 1, 'the answer is split, not dropped')
    assert.ok(sent.every((call) => call.payload.parse_mode === 'HTML'))
    assert.ok(sent.every((call) => call.payload.text.length <= 4096))
    const text = sent.map((call) => call.payload.text).join('\n')
    assert.match(text, /step 0/)
    assert.match(text, /step 119/)
    assert.equal((text.match(/• /g) ?? []).length, 120)
  }
  finally {
    harness.dispose()
    await bot.close()
  }
})

test('wiring: follow-up turns of one task coalesce into the last answer', async () => {
  const bot = await startFakeBot()
  const harness = fakeContext()
  try {
    apply(harness.ctx, { chatId: '4242', token: '123456:AAexample-token-value', apiBase: bot.base })
    const session = rootSession()
    emitTurn(harness, session, { text: 'first interim result' })
    await wait(200)
    emitTurn(harness, session, { text: 'the **final** result', user: 'keep going' })
    await wait(2300)
    const sent = bot.methods('sendMessage')
    assert.equal(sent.length, 1)
    assert.match(sent[0].payload.text, /the <b>final<\/b> result/)
    assert.doesNotMatch(sent[0].payload.text, /first interim result/)
  }
  finally {
    harness.dispose()
    await bot.close()
  }
})

test('wiring: a turn that ends mid-run waits for the agent to go idle', async () => {
  const bot = await startFakeBot()
  let status = 'running'
  const harness = fakeContext({ agents: { get: () => ({ id: 'session-1', status }) } })
  try {
    apply(harness.ctx, { chatId: '4242', token: '123456:AAexample-token-value', apiBase: bot.base })
    emitTurn(harness, rootSession(), { text: 'interim answer' })
    await wait(2600)
    assert.equal(bot.methods('sendMessage').length, 0, 'the harness is still working on the same run')
    status = 'idle'
    await wait(2600)
    const sent = bot.methods('sendMessage')
    assert.equal(sent.length, 1, 'the run is announced once it is over')
    assert.match(sent[0].payload.text, /interim answer/)
  }
  finally {
    harness.dispose()
    await bot.close()
  }
})

test('wiring: a report waits while subagents are still working', async () => {
  const bot = await startFakeBot()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const harness = fakeContext({
    agents: { get: () => ({ id: 'session-1', status: 'idle' }) },
    // The first check joins running children; later ones find them idle.
    subagents: { waitForChildren: () => (calls++ === 0 ? gate : Promise.resolve(false)) },
  })
  try {
    apply(harness.ctx, { chatId: '4242', token: '123456:AAexample-token-value', apiBase: bot.base })
    emitTurn(harness, rootSession(), { text: 'interim report' })
    await wait(2200)
    assert.equal(bot.methods('sendMessage').length, 0, 'children are still working')
    release(true)
    await wait(2300)
    const sent = bot.methods('sendMessage')
    assert.equal(sent.length, 1)
    assert.match(sent[0].payload.text, /interim report/)
  }
  finally {
    harness.dispose()
    await bot.close()
  }
})

test('wiring: an unattended run stays silent by default', async () => {
  const bot = await startFakeBot()
  const harness = fakeContext()
  try {
    apply(harness.ctx, { chatId: '4242', token: '123456:AAexample-token-value', apiBase: bot.base })
    emitTurn(harness, rootSession(), { text: 'nothing new', source: 'schedule', user: '[scheduled check]' })
    await wait(2300)
    assert.equal(bot.methods('sendMessage').length, 0)
  }
  finally {
    harness.dispose()
    await bot.close()
  }
})

test('wiring: notifyBackground reports an unattended run', async () => {
  const bot = await startFakeBot()
  const harness = fakeContext()
  try {
    apply(harness.ctx, {
      chatId: '4242',
      token: '123456:AAexample-token-value',
      apiBase: bot.base,
      notifyBackground: true,
    })
    emitTurn(harness, rootSession(), { text: 'fresh review comments', source: 'schedule', user: '[scheduled check]' })
    await wait(2300)
    const sent = bot.methods('sendMessage')
    assert.equal(sent.length, 1)
    assert.match(sent[0].payload.text, /fresh review comments/)
  }
  finally {
    harness.dispose()
    await bot.close()
  }
})

test('wiring: the background switch works without task messages', async () => {
  const bot = await startFakeBot()
  const harness = fakeContext()
  try {
    apply(harness.ctx, {
      chatId: '4242',
      token: '123456:AAexample-token-value',
      apiBase: bot.base,
      notifyTurnComplete: false,
      notifyBackground: true,
    })
    emitTurn(harness, rootSession(), { text: 'scheduled result', source: 'schedule', user: '[scheduled check]' })
    await wait(2300)
    const sent = bot.methods('sendMessage')
    assert.equal(sent.length, 1)
    assert.match(sent[0].payload.text, /scheduled result/)
  }
  finally {
    harness.dispose()
    await bot.close()
  }
})

test('wiring: an answer with no text sends nothing', async () => {
  const bot = await startFakeBot()
  const harness = fakeContext()
  try {
    apply(harness.ctx, { chatId: '4242', token: '123456:AAexample-token-value', apiBase: bot.base })
    emitTurn(harness, rootSession(), { text: '' })
    await wait(2300)
    assert.equal(bot.methods('sendMessage').length, 0)
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
