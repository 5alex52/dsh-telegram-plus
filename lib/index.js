/**
 * dsh-telegram-plus — Telegram notifications and question answering for
 * DeepSeek Harness.
 *
 * Local fork of dsh-telegram-notify 0.2.3. Two differences from upstream:
 *
 *   - Messages use Telegram's HTML parse mode. Markdown in model output is
 *     rendered as <b>/<i>/<s>/<code>/<pre>/<blockquote>/<a>, every value is
 *     escaped, long text is split into several messages instead of being cut,
 *     and a rejected entity falls back to plain text so a message is never
 *     lost.
 *   - When `allowReplies` is on and `chatId` is numeric, a pending
 *     `ask_user_question` is posted with one inline button per option. The bot
 *     long-polls for a button press or a text reply and answers the question in
 *     DSH, racing the browser answerer so answering in either place works.
 *
 * A finished task is announced once, when the agent goes quiet and the last
 * answer is final: intermediate turns of one run are coalesced, an answer with
 * no text is skipped, and background (scheduled) runs stay silent unless the
 * user is needed. Turn errors, questions, plan reviews and approvals are
 * pushed immediately. Subagent sessions stay ignored.
 *
 * @module dsh-telegram-plus
 */
import { basename } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Plugin name; also the loader row id, settings namespace and logger name. */
export const name = 'telegram-plus'
/** Credential resolution is the only required service. Settings is optional. */
export const inject = ['credentials']

const DEFAULT_TOKEN_REF = 'TELEGRAM_BOT_TOKEN'
const DEFAULT_API_BASE = 'https://api.telegram.org'
/** HTML characters per message; a split leaves room for closing tags under Telegram's 4096. */
const HTML_PART_LIMIT = 3900
/** Source characters per plain-text message. */
const TEXT_BUDGET = 3800
/** Upper bound for one notification before it is split. */
const MAX_TOTAL = 30_000
/** Delay before a question notification, so an instantly-failing tool call is not announced. */
const QUESTION_SETTLE_MS = 400
/** Delay before an approval notification, so policy-decided asks are not announced. */
const APPROVAL_SETTLE_MS = 400
/**
 * Quiet window after a turn ends. A follow-up turn of the same run cancels the
 * pending message, so one task produces one notification instead of one per
 * turn; the last turn's answer is what the chat receives.
 */
const COMPLETION_SETTLE_MS = 2000
const USER_SNIPPET = 500
const DETAIL_SNIPPET = 3000
const REASON_SNIPPET = 400
/** Long-poll window for getUpdates, in seconds. */
const POLL_TIMEOUT_SECONDS = 25
/** Marker for "the UI answerer does not exist; keep waiting for Telegram". */
const STANDSTILL = Symbol('standstill')

export const Config = z.object({
    chatId: z
        .union([z.string(), z.number()])
        .default('')
        .description('Telegram chat id that receives the notifications. Quote it when it starts with -.')
        .volatile(),
    tokenRef: z
        .string()
        .role('credential-ref')
        .default(DEFAULT_TOKEN_REF)
        .description('Credential reference holding the Telegram bot token.')
        .volatile(),
    token: z
        .string()
        .role('secret')
        .description('Literal bot token. Prefer tokenRef; use this only for one-off local runs.'),
    apiBase: z.string().default(DEFAULT_API_BASE).description('Bot API base URL. Change only for a local Bot API server.'),
    silent: z.boolean().default(false).description('Send messages without a notification sound.').volatile(),
    format: z
        .string()
        .default('html')
        .description("Message formatting: 'html' renders markdown with Telegram HTML, 'plain' sends raw text.")
        .volatile(),
    allowReplies: z
        .boolean()
        .default(true)
        .description('Read Telegram replies and answer pending questions from there.')
        .volatile(),
    answerTimeoutMinutes: z
        .number()
        .default(0)
        .description('Close a Telegram question prompt after this many minutes. 0 waits until the question ends.')
        .volatile(),
    notifyTurnComplete: z
        .boolean()
        .default(true)
        .description('Notify once when a task you started finishes, with the full final answer.')
        .volatile(),
    notifyBackground: z
        .boolean()
        .default(false)
        .description('Also report scheduled or unattended runs when they finish without asking anything.')
        .volatile(),
    notifyTurnError: z
        .boolean()
        .default(true)
        .description('Notify on turn errors, blocked turns and max-token stops.')
        .volatile(),
    notifyTurnAborted: z.boolean().default(false).description('Notify when a turn is cancelled.').volatile(),
    notifyQuestions: z.boolean().default(true).description('Notify when the agent is waiting for an answer.').volatile(),
    notifyPlanReviews: z
        .boolean()
        .default(true)
        .description('Notify when a plan is waiting for approval.')
        .volatile(),
    notifyApprovals: z
        .boolean()
        .default(true)
        .description('Notify when a tool approval is waiting for the human.')
        .volatile(),
})
// ───────────────────────────── configuration ─────────────────────────────
function normalizeApiBase(value) {
    const raw = typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULT_API_BASE
    let url
    try {
        url = new URL(raw)
    }
    catch {
        return undefined
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return undefined
    return raw.replace(/\/+$/, '')
}
/**
 * Normalize user config into the shape the handlers read. Kept separate from
 * the schemastery schema because tests and direct mounts may call `apply`
 * with a plain object.
 * @param raw - user configuration.
 * @returns resolved settings, or `undefined` when a value is unusable.
 */
function unwrap(value) {
    if (value === null || typeof value !== 'object')
        return value
    const holder = value
    return typeof holder.get === 'function' ? holder.get() : value
}
/** @param raw - user configuration. @returns resolved settings, or `undefined` when a value is unusable. */
export function resolveSettings(raw = {}) {
    const source = raw !== null && typeof raw === 'object' ? raw : {}
    const apiBase = normalizeApiBase(unwrap(source.apiBase))
    if (apiBase === undefined)
        return undefined
    const tokenValue = unwrap(source.token)
    const token = typeof tokenValue === 'string' ? tokenValue.trim() : ''
    const refValue = unwrap(source.tokenRef)
    const tokenRef = typeof refValue === 'string' && refValue.trim() !== '' ? refValue.trim() : DEFAULT_TOKEN_REF
    if (token === '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenRef))
        return undefined
    const timeoutMinutes = Number(unwrap(source.answerTimeoutMinutes))
    return {
        chatId: String(unwrap(source.chatId) ?? '').trim(),
        token,
        tokenRef,
        apiBase,
        format: unwrap(source.format) === 'plain' ? 'plain' : 'html',
        allowReplies: unwrap(source.allowReplies) !== false,
        answerTimeoutMinutes: Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 ? timeoutMinutes : 0,
        silent: unwrap(source.silent) === true,
        notifyTurnComplete: unwrap(source.notifyTurnComplete) !== false,
        notifyBackground: unwrap(source.notifyBackground) === true,
        notifyTurnError: unwrap(source.notifyTurnError) !== false,
        notifyTurnAborted: unwrap(source.notifyTurnAborted) === true,
        notifyQuestions: unwrap(source.notifyQuestions) !== false,
        notifyPlanReviews: unwrap(source.notifyPlanReviews) !== false,
        notifyApprovals: unwrap(source.notifyApprovals) !== false,
    }
}
// ───────────────────────────── text helpers ─────────────────────────────
const PLACEHOLDER = '\u0000'
/** Escape a value for Telegram's HTML parse mode. */
export function escapeXml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}
/** Remove tags and entities, for the plain-text fallback. */
export function stripHtml(value) {
    return String(value ?? '')
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
}
/** Concatenate text blocks from a DSH message. */
export function messageText(message) {
    const content = message?.content
    if (!Array.isArray(content))
        return ''
    let text = ''
    for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
            text += (text === '' ? '' : '\n') + block.text
        }
    }
    return text.trim()
}
/** Collapse a multi-line value into a compact one-line snippet. */
export function snippet(value, limit = USER_SNIPPET) {
    const text = String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
    if (text.length <= limit)
        return text
    return `${text.slice(0, Math.max(0, limit - 1))}…`
}
/** Clip a value while preserving newlines, for plan and question detail. */
export function clip(value, limit = DETAIL_SNIPPET) {
    const text = String(value ?? '').trim()
    if (text.length <= limit)
        return text
    return `${text.slice(0, Math.max(0, limit - 1))}…`
}
// ─────────────────────────── markdown → HTML ───────────────────────────
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+#.\-]{0,32})\s*$/
const FENCE_CLOSE = /^\s{0,3}(`{3,}|~{3,})\s*$/
const BLOCKQUOTE = /^\s{0,3}>\s?/
const TABLE_ROW = /^\s{0,3}\|.*\|\s*$/
/** Bold, italic and strikethrough on already-escaped text. */
function emphasis(escaped) {
    return escaped
        .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<b><i>$1</i></b>')
        .replace(/___([^_\n]+)___/g, '<b><i>$1</i></b>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/__([^_\n]+)__/g, '<b>$1</b>')
        .replace(/(^|[\s("'«„—-])\*(?!\s)([^*\n]+?)(?<!\s)\*/g, '$1<i>$2</i>')
        .replace(/(^|[\s("'«„—-])_(?!\s)([^_\n]+?)(?<!\s)_/g, '$1<i>$2</i>')
        .replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
}
/**
 * Render one line of markdown as Telegram HTML. Code spans and links are
 * stashed first so emphasis never rewrites their contents, and all remaining
 * text is escaped before any tag is produced.
 * @param text - one source line.
 * @returns HTML that Telegram's HTML parse mode accepts.
 */
export function inlineToHtml(text) {
    const slots = []
    const stash = (html) => {
        slots.push(html)
        return `${PLACEHOLDER}${slots.length - 1}${PLACEHOLDER}`
    }
    let value = String(text ?? '')
    value = value.replace(/`([^`\n]+)`/g, (_match, code) => stash(`<code>${escapeXml(code)}</code>`))
    value = value.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => stash(`<a href="${escapeXml(url)}">${escapeXml(label)}</a>`))
    value = emphasis(escapeXml(value))
    return value.replace(/\u0000(\d+)\u0000/g, (_match, index) => slots[Number(index)] ?? '')
}
function preBlock(body, language) {
    const escaped = escapeXml(body)
    const lang = typeof language === 'string' && /^[A-Za-z0-9_+#.\-]{1,32}$/.test(language) ? language : ''
    return lang === ''
        ? `<pre>${escaped}</pre>`
        : `<pre><code class="language-${lang}">${escaped}</code></pre>`
}
function blockLine(line) {
    const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
        const title = heading[2].replace(/\s+#+\s*$/, '')
        return `<b>${inlineToHtml(title)}</b>`
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line))
        return '──────────'
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet !== null)
        return `${bullet[1]}• ${inlineToHtml(bullet[2])}`
    const ordered = /^(\s*)(\d{1,3})[.)]\s+(.*)$/.exec(line)
    if (ordered !== null)
        return `${ordered[1]}<b>${ordered[2]}.</b> ${inlineToHtml(ordered[3])}`
    return inlineToHtml(line)
}
/**
 * Convert a markdown fragment to the HTML subset Telegram renders.
 * @param markdown - model or human text.
 * @returns Telegram HTML.
 */
export function toTelegramHtml(markdown) {
    const text = String(markdown ?? '').replace(/\r\n?/g, '\n')
    if (text.trim() === '')
        return ''
    const lines = text.split('\n')
    const out = []
    let index = 0
    while (index < lines.length) {
        const line = lines[index]
        const fence = FENCE_OPEN.exec(line)
        if (fence !== null) {
            const marker = fence[1]
            const body = []
            index += 1
            while (index < lines.length) {
                const closing = FENCE_CLOSE.exec(lines[index])
                if (closing !== null && closing[1][0] === marker[0])
                    break
                body.push(lines[index])
                index += 1
            }
            index += 1
            out.push(preBlock(body.join('\n'), fence[2]))
            continue
        }
        if (BLOCKQUOTE.test(line)) {
            const body = []
            while (index < lines.length && BLOCKQUOTE.test(lines[index])) {
                body.push(lines[index].replace(BLOCKQUOTE, ''))
                index += 1
            }
            out.push(`<blockquote>${body.map(blockLine).join('\n')}</blockquote>`)
            continue
        }
        if (TABLE_ROW.test(line)) {
            const body = []
            while (index < lines.length && TABLE_ROW.test(lines[index])) {
                body.push(lines[index])
                index += 1
            }
            out.push(`<pre>${escapeXml(body.join('\n'))}</pre>`)
            continue
        }
        out.push(blockLine(line))
        index += 1
    }
    return collapseBlankLines(out.join('\n')).trim()
}
/**
 * Collapse runs of blank lines, except inside a code block where the blank
 * lines belong to the code the model wrote.
 */
function collapseBlankLines(html) {
    const lines = html.split('\n')
    const out = []
    let inPre = false
    let blanks = 0
    for (const line of lines) {
        const opens = line.includes('<pre>')
        const closes = line.includes('</pre>')
        if (!inPre && !opens && line.trim() === '') {
            blanks += 1
            if (blanks > 1)
                continue
        }
        else {
            blanks = 0
        }
        out.push(line)
        if (opens && !closes)
            inPre = true
        if (closes)
            inPre = false
    }
    return out.join('\n')
}
/**
 * Split long text on line boundaries so each part converts to one Telegram
 * message. Lines longer than the budget are cut in fixed windows.
 * @param text - source text, before formatting.
 * @param budget - maximum source characters per part.
 * @returns the parts, in order.
 */
export function splitForTelegram(text, budget = TEXT_BUDGET) {
    const source = String(text ?? '')
    if (source.length <= budget)
        return [source]
    const parts = []
    let current = ''
    for (const line of source.split('\n')) {
        if (line.length > budget) {
            if (current !== '') {
                parts.push(current)
                current = ''
            }
            for (let offset = 0; offset < line.length; offset += budget)
                parts.push(line.slice(offset, offset + budget))
            continue
        }
        const candidate = current === '' ? line : `${current}\n${line}`
        if (candidate.length > budget) {
            parts.push(current)
            current = line
            continue
        }
        current = candidate
    }
    if (current !== '')
        parts.push(current)
    return parts
}
/**
 * Split rendered Telegram HTML into messages Telegram accepts, without
 * breaking formatting: a split closes every tag still open at the boundary and
 * reopens it in the next part. Text is cut on a line break when one is near,
 * otherwise at a safe character boundary (never inside a tag or an entity).
 * @param html - rendered Telegram HTML.
 * @param limit - maximum characters per part.
 * @returns the parts, in order.
 */
export function splitTelegramHtml(html, limit = HTML_PART_LIMIT) {
    const source = String(html ?? '')
    if (source.length <= limit)
        return source === '' ? [] : [source]
    const parts = []
    const open = []
    const closing = () => open.map((entry) => `</${entry.tag}>`).reverse().join('')
    const reopening = () => open.map((entry) => entry.token).join('')
    const hasText = (value) => value.replace(/<[^>]*>/g, '').trim() !== ''
    let buffer = ''
    const flush = () => {
        const body = buffer.replace(/[ \t]+$/, '').replace(/^\n+/, '')
        if (hasText(body))
            parts.push(body + closing())
        buffer = reopening()
    }
    const applyTag = (token) => {
        const match = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>$/.exec(token)
        if (match === null)
            return
        if (match[1] === '/') {
            for (let index = open.length - 1; index >= 0; index -= 1) {
                if (open[index].tag === match[2]) {
                    open.splice(index, 1)
                    break
                }
            }
            return
        }
        if (match[2] !== 'br')
            open.push({ tag: match[2], token })
    }
    const cutSafely = (run, offset, take) => {
        // Never cut an escaping entity or a surrogate pair in half.
        let cut = take
        const code = run.charCodeAt(offset + cut - 1)
        if (code >= 0xd800 && code <= 0xdbff)
            cut -= 1
        for (let back = 1; back <= Math.min(12, cut); back += 1) {
            const character = run[offset + cut - back]
            if (character === '&' && !run.slice(offset + cut - back, offset + cut).includes(';'))
                return cut - back
        }
        return cut
    }
    const appendText = (run) => {
        let offset = 0
        while (offset < run.length) {
            const room = limit - buffer.length - closing().length
            if (room <= 0) {
                flush()
                continue
            }
            let take = Math.min(room, run.length - offset)
            if (offset + take < run.length) {
                const window = run.slice(offset, offset + take)
                const newline = window.lastIndexOf('\n')
                take = newline >= Math.floor(take * 0.6) ? newline + 1 : cutSafely(run, offset, take)
                if (take <= 0)
                    take = 1
            }
            buffer += run.slice(offset, offset + take)
            offset += take
            if (offset < run.length)
                flush()
        }
    }
    let index = 0
    while (index < source.length) {
        if (source[index] === '<') {
            const end = source.indexOf('>', index)
            if (end === -1) {
                appendText(source.slice(index))
                break
            }
            const token = source.slice(index, end + 1)
            const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>$/.exec(token)
            // An opening tag also needs room for the closing tag that a split
            // would append to this part.
            const reserve = tag !== null && tag[1] === '' && tag[2] !== 'br' ? tag[2].length + 3 : 0
            if (buffer.length + token.length + closing().length + reserve > limit)
                flush()
            applyTag(token)
            buffer += token
            index = end + 1
            continue
        }
        const next = source.indexOf('<', index)
        const end = next === -1 ? source.length : next
        appendText(source.slice(index, end))
        index = end
    }
    const tail = buffer.replace(/^\n+/, '')
    if (hasText(tail))
        parts.push(tail + closing())
    return parts.length === 0 ? [source] : parts
}
// ───────────────────────────── formatters ─────────────────────────────
function finalize(lines) {
    const text = lines
        .join('\n')
        .replace(/^\n+/, '')
        .replace(/\n+$/, '')
    if (text.length <= MAX_TOTAL)
        return text
    return `${text.slice(0, MAX_TOTAL - 1)}…`
}
/** Add a blank line before a non-empty block, keeping sections visually separate. */
function pushBlock(lines, block) {
    if (block === '')
        return
    lines.push('', block)
}
function workspaceOf(session) {
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '')
        return 'DSH'
    const leaf = basename(cwd)
    return leaf === '' ? cwd : leaf
}
function scopeLine(session, state, icon = '📁') {
    const workspace = workspaceOf(session)
    const title = typeof state?.title === 'string' ? state.title.trim() : ''
    return `${icon} ${workspace}${title !== '' && title !== workspace ? ` — ${title}` : ''}`
}
function lastUserLine(state) {
    const user = snippet(state?.user)
    return user === '' ? '' : `👤 ${user}`
}
function isRootSession(session) {
    const header = session.header
    if (header.origin === 'subagent')
        return false
    return (header.delegationDepth ?? 0) === 0
}
/**
 * Format the final answer of a finished task. The answer is kept whole — every
 * paragraph, list and code block — so the chat shows the same markdown the DSH
 * transcript does; an answer with no text produces no message at all.
 * @param session - the session the task ran in.
 * @param state - tracked session state.
 * @returns markdown, or an empty string when there is nothing to report.
 */
export function formatCompleted(session, state) {
    const answer = String(state?.assistant ?? '').trim()
    if (answer === '')
        return ''
    return finalize([scopeLine(session, state, '✅'), '', answer])
}
/** Format a failed turn. */
export function formatError(session, state, error) {
    const message = snippet(error?.message ?? 'The turn failed.', REASON_SNIPPET)
    const code = typeof error?.code === 'string' && error.code !== '' ? ` (${error.code})` : ''
    const status = typeof error?.status === 'number' ? ` · HTTP ${error.status}` : ''
    const lines = ['❌ **Turn failed**', scopeLine(session, state)]
    pushBlock(lines, lastUserLine(state))
    pushBlock(lines, `⚠️ ${message}${code}${status}`)
    return finalize(lines)
}
/** Format a turn that stopped without an error (max tokens or blocked). */
export function formatWarning(session, state, kind) {
    const reason = kind === 'max-tokens'
        ? 'the output-token limit was reached'
        : kind === 'blocked'
            ? 'the turn was blocked'
            : `the turn ended (${kind})`
    const lines = ['⚠️ **Turn stopped**', scopeLine(session, state)]
    pushBlock(lines, lastUserLine(state))
    pushBlock(lines, `Reason: ${reason}`)
    return finalize(lines)
}
/** Format a cancelled turn. */
export function formatAborted(session, state, reason) {
    const cause = reason.kind === 'aborted' ? reason.reason.kind : undefined
    const lines = ['⏹ **Turn cancelled**', scopeLine(session, state)]
    pushBlock(lines, lastUserLine(state))
    if (typeof cause === 'string')
        pushBlock(lines, `Cause: ${cause}`)
    return finalize(lines)
}
function optionsBlock(question) {
    const options = Array.isArray(question.options) ? question.options : []
    if (options.length === 0)
        return []
    return ['Options:', ...options.map((option) => `• ${snippet(option?.label, 160)}`)]
}
function questionBlock(question, position, total) {
    const block = []
    const header = snippet(question?.header, 120)
    const label = total > 1 ? `${position + 1}. ` : ''
    if (header !== '')
        block.push(`**${label}${header}**`)
    else if (label !== '')
        block.push(`**${label.slice(0, -2)}**`)
    block.push(snippet(question?.question, 500) || 'The agent asked a question.')
    const detailLimit = question?.intent?.kind === 'plan-review' ? MAX_TOTAL : DETAIL_SNIPPET
    const detail = clip(question?.detail, detailLimit)
    if (detail !== '')
        block.push(detail)
    block.push(...optionsBlock(question))
    return block.join('\n')
}
/** Format one or more pending user questions. */
export function formatQuestions(session, state, questions) {
    const lines = ['❓ **Waiting for your input**', scopeLine(session, state)]
    const visible = questions.slice(0, 4)
    visible.forEach((question, position) => {
        pushBlock(lines, questionBlock(question, position, visible.length))
    })
    return finalize(lines)
}
/** Text added under a Telegram question prompt; also its inline guidance. */
export function questionHint(questionCount) {
    return questionCount <= 1
        ? '_Tap an option or reply with your answer._'
        : `_Reply with ${questionCount} lines: one answer per question, in order._`
}
/** Split a markdown plan into a one-line title and the remaining body. */
function planParts(plan) {
    const text = String(plan ?? '').trim()
    const newline = text.indexOf('\n')
    const first = (newline === -1 ? text : text.slice(0, newline)).trim()
    if (!first.startsWith('#'))
        return { heading: '', body: clip(text, MAX_TOTAL) }
    return {
        heading: snippet(first.replace(/^#+\s*/, ''), 160),
        body: clip(text.slice(first.length).trim(), MAX_TOTAL),
    }
}
/** Format a plan waiting for approval. */
export function formatPlan(session, state, plan) {
    const { heading, body } = planParts(plan)
    const lines = ['📋 **Plan ready for approval**', scopeLine(session, state)]
    pushBlock(lines, lastUserLine(state))
    pushBlock(lines, [heading === '' ? '' : `📌 **${heading}**`, body].filter((line) => line !== '').join('\n'))
    pushBlock(lines, 'Review it in the DSH UI to approve or keep planning.')
    return finalize(lines)
}
/** Format a pending tool approval. */
export function formatApproval(session, state, request) {
    const tool = snippet(request.toolName, 120)
    const reason = snippet(request.reason, REASON_SNIPPET)
    const lines = ['🔐 **Approval needed**', scopeLine(session, state)]
    pushBlock(lines, lastUserLine(state))
    pushBlock(lines, [tool === '' ? '' : `Tool: \`${tool}\``, reason === '' ? '' : `Reason: ${reason}`]
        .filter((line) => line !== '')
        .join('\n'))
    pushBlock(lines, 'Approve or reject it in the DSH UI.')
    return finalize(lines)
}
/** Find the reviewed plan carried by a plan-review question, including its detail. */
export function planFromQuestions(questions) {
    const question = questions.find((candidate) => candidate?.intent?.kind === 'plan-review')
    return typeof question?.detail === 'string' ? question.detail : ''
}
function parseArguments(value) {
    if (typeof value !== 'string' || value === '')
        return undefined
    try {
        const parsed = JSON.parse(value)
        return parsed !== null && typeof parsed === 'object' ? parsed : undefined
    }
    catch {
        return undefined
    }
}
function questionsFromArguments(value) {
    const parsed = parseArguments(value)
    return Array.isArray(parsed?.questions) ? parsed.questions : []
}
// ───────────────────────────── telegram api ─────────────────────────────
function tokenIsSafe(token) {
    return token !== '' && !/[\s/?#]/.test(token)
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error)
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
async function resolveToken(ctx, settings) {
    if (settings.token !== '')
        return settings.token
    if (typeof ctx.credentials?.resolve !== 'function')
        throw new Error(`credential ${settings.tokenRef} is unavailable`)
    let resolved
    try {
        resolved = await ctx.credentials.resolve(settings.tokenRef)
    }
    catch {
        throw new Error(`credential ${settings.tokenRef} could not be resolved`)
    }
    if (resolved === undefined || typeof resolved.value !== 'string' || resolved.value === '') {
        throw new Error(`credential ${settings.tokenRef} is not set`)
    }
    return resolved.value
}
/**
 * One Bot API client over the configured chat. Every call resolves the token
 * at call time so credential edits apply without a remount.
 * @param options - context, settings reader and logger.
 */
export function createApi({ ctx, readSettings, logger }) {
    async function request(method, payload, { signal } = {}) {
        const settings = readSettings()
        if (settings === undefined)
            throw new Error('the Telegram configuration is unusable')
        const token = await resolveToken(ctx, settings)
        if (!tokenIsSafe(token))
            throw new Error('the configured bot token is malformed')
        const endpoint = `${settings.apiBase}/bot${token}/${method}`
        for (let attempt = 0; attempt < 2; attempt += 1) {
            let response
            try {
                response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: signal ?? AbortSignal.timeout(15_000),
                })
            }
            catch (error) {
                if (signal?.aborted)
                    throw error
                throw new Error('the Telegram API is unreachable')
            }
            let parsed
            try {
                parsed = await response.json()
            }
            catch {
                parsed = undefined
            }
            if (response.ok)
                return { result: parsed?.result, payload: parsed }
            const retryAfter = Number(parsed?.parameters?.retry_after)
            if (response.status === 429 && attempt === 0) {
                await sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000, 5000))
                continue
            }
            const error = new Error(`Telegram ${method} failed: HTTP ${response.status}${parsed?.description === undefined ? '' : ` (${parsed.description})`}`)
            error.telegramStatus = response.status
            error.telegramDescription = parsed?.description
            throw error
        }
        throw new Error(`Telegram ${method} failed`)
    }
    /**
     * Send one message. A rejected HTML entity retries once as plain text so
     * malformed model output cannot swallow the notification.
     * @param options - text, optional keyboard and formatting.
     */
    async function sendMessage({ text, parseMode, replyMarkup, signal, silent = false, chatId }) {
        const settings = readSettings()
        if (settings === undefined)
            return undefined
        const body = {
            chat_id: chatId ?? settings.chatId,
            text,
            disable_notification: silent,
            link_preview_options: { is_disabled: true },
            ...(parseMode === undefined ? {} : { parse_mode: parseMode }),
            ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
        }
        try {
            return await request('sendMessage', body, { signal })
        }
        catch (error) {
            if (parseMode !== 'HTML' || error?.telegramStatus !== 400)
                throw error
            logger?.warn?.(`telegram-plus: HTML rejected (${describeError(error)}); retrying as plain text`)
            return await request('sendMessage', { ...body, text: stripHtml(text), parse_mode: undefined }, { signal })
        }
    }
    async function editMessageText({ text, messageId, chatId, replyMarkup, parseMode = 'HTML' }) {
        const settings = readSettings()
        if (settings === undefined)
            return undefined
        try {
            return await request('editMessageText', {
                chat_id: chatId ?? settings.chatId,
                message_id: messageId,
                text,
                link_preview_options: { is_disabled: true },
                ...(parseMode === undefined ? {} : { parse_mode: parseMode }),
                ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
            })
        }
        catch (error) {
            if (parseMode !== 'HTML' || error?.telegramStatus !== 400)
                throw error
            return await request('editMessageText', {
                chat_id: chatId ?? settings.chatId,
                message_id: messageId,
                text: stripHtml(text),
                ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
            })
        }
    }
    async function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
        return await request('answerCallbackQuery', {
            callback_query_id: callbackQueryId,
            ...(text === undefined ? {} : { text }),
            ...(showAlert ? { show_alert: true } : {}),
        })
    }
    async function getUpdates({ offset, timeout = POLL_TIMEOUT_SECONDS, signal }) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(new Error('getUpdates window elapsed')), (timeout + 15) * 1000)
        const combined = signal === undefined
            ? controller.signal
            : AbortSignal.any([signal, controller.signal])
        try {
            const response = await request('getUpdates', {
                offset,
                timeout,
                allowed_updates: ['message', 'callback_query'],
            }, { signal: combined })
            return Array.isArray(response.result) ? response.result : []
        }
        finally {
            clearTimeout(timer)
        }
    }
    return { request, sendMessage, editMessageText, answerCallbackQuery, getUpdates }
}
/**
 * Send one message, retrying once when Telegram asks to wait (HTTP 429).
 * @param options - endpoint and message fields.
 */
export async function sendTelegram(options) {
    const { apiBase, token, chatId, text, silent = false, parseMode } = options
    if (!tokenIsSafe(token))
        throw new Error('the configured bot token is malformed')
    const endpoint = `${apiBase}/bot${token}/sendMessage`
    const body = {
        chat_id: chatId,
        text,
        disable_notification: silent,
        link_preview_options: { is_disabled: true },
        ...(parseMode === undefined ? {} : { parse_mode: parseMode }),
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
        let response
        try {
            response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(10_000),
            })
        }
        catch {
            throw new Error('the Telegram API is unreachable')
        }
        if (response.ok)
            return
        let payload
        try {
            payload = (await response.json())
        }
        catch {
            payload = undefined
        }
        if (response.status === 429 && attempt === 0) {
            const retryAfter = Number(payload?.parameters?.retry_after)
            await sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000, 5000))
            continue
        }
        const description = snippet(payload?.description, 200)
        throw new Error(`Telegram sendMessage failed: HTTP ${response.status}${description === '' ? '' : ` (${description})`}`)
    }
}
// ─────────────────────── question broker (two-way) ───────────────────────
function abortReason(message) {
    const error = new Error(message)
    error.name = 'AbortError'
    return error
}
/**
 * Holds pending Telegram question prompts and answers them from a button press
 * or a chat reply. Every prompt is keyed by a short id that rides in the
 * callback data, so a stale button press after the question ended is inert.
 * @param options - settings reader, logger, Bot API client and session state.
 */
export function createBroker({ readSettings, logger, api, stateFor }) {
    const pending = new Map()
    let counter = 0
    function nextId() {
        counter += 1
        return counter.toString(36)
    }
    function keyboardFor(id, questions) {
        const rows = []
        questions.forEach((question, questionIndex) => {
            const options = Array.isArray(question?.options) ? question.options : []
            options.forEach((option, optionIndex) => {
                const label = snippet(option?.label, 60)
                if (label === '')
                    return
                rows.push([{ text: label, callback_data: `q${id}:${questionIndex}:${optionIndex}` }])
            })
        })
        return rows.length === 0 ? undefined : { inline_keyboard: rows }
    }
    function approvalKeyboard(id) {
        return {
            inline_keyboard: [[
                { text: '✅ Allow once', callback_data: `a${id}:y` },
                { text: '❌ Reject', callback_data: `a${id}:n` },
            ]],
        }
    }
    function promptMarkdown(session, state, questions) {
        return `${formatQuestions(session, state, questions)}\n\n${questionHint(questions.length)}`
    }
    function approvalMarkdown(session, state, request) {
        return `${formatApproval(session, state, request)}\n\n_Tap Allow once or Reject._`
    }
    /** Retire a prompt exactly once, dropping its buttons and appending a note. */
    function release(entry, note) {
        if (entry.settled)
            return false
        entry.settled = true
        pending.delete(entry.id)
        if (entry.timer !== undefined)
            clearTimeout(entry.timer)
        entry.signal?.removeEventListener('abort', entry.onAbort)
        const text = note === undefined
            ? entry.html
            : `${entry.html}\n\n<i>${escapeXml(note)}</i>`
        void api.editMessageText({
            messageId: entry.messageId,
            chatId: entry.chatId,
            text,
            replyMarkup: { inline_keyboard: [] },
        }).catch(() => { })
        return true
    }
    function fulfil(entry, note) {
        const answer = { answers: entry.questions.map((question) => entry.answers.get(question.id) ?? { id: question.id, selected: [] }) }
        if (!release(entry, note))
            return
        entry.deferred.resolve(answer)
    }
    function abandon(entry, note, reason) {
        if (!release(entry, note))
            return
        entry.deferred.reject(abortReason(reason))
    }
    /** Close a prompt by id, used when the DSH UI answered first. */
    function close(id, note) {
        const entry = pending.get(id)
        if (entry === undefined)
            return
        abandon(entry, note, 'the question was answered in the DSH UI')
    }
    /**
     * Post one question prompt and return its answer promise.
     * @param request - the DSH question request.
     * @param signal - lifetime shared with the DSH ask.
     * @returns delivery result: the prompt id and its answer promise.
     */
    /**
     * Post one prompt and register it. Shared by questions and approvals so
     * both get the same abort, timeout and edit behaviour.
     * @param options - prompt kind, markdown, keyboard factory and lifetime.
     * @returns delivery result: the prompt id and its answer promise.
     */
    async function post({ kind, markdown, keyboard, questions, signal }) {
        const settings = readSettings()
        if (settings === undefined || settings.chatId === '')
            return { delivered: false }
        const deferred = Promise.withResolvers()
        const id = nextId()
        // A long prompt (a plan review, several questions) is split like any
        // other message; the buttons ride on the last part, next to the end.
        const parts = splitTelegramHtml(toTelegramHtml(markdown) || escapeXml(markdown))
        let message
        try {
            for (let index = 0; index < parts.length; index += 1) {
                message = await api.sendMessage({
                    text: parts[index],
                    parseMode: 'HTML',
                    replyMarkup: index === parts.length - 1 ? keyboard(id) : undefined,
                    signal,
                })
            }
        }
        catch (error) {
            logger.warn(`telegram-plus: could not post the ${kind} (${describeError(error)}); the DSH UI owns it`)
            return { delivered: false }
        }
        const messageId = message?.result?.message_id
        if (messageId === undefined)
            return { delivered: false }
        const entry = {
            id,
            kind,
            chatId: settings.chatId,
            messageId,
            html: parts[parts.length - 1] ?? '',
            questions,
            answers: new Map(),
            deferred,
            signal,
            settled: false,
            timer: undefined,
            onAbort: undefined,
        }
        if (signal.aborted) {
            void api.editMessageText({
                messageId,
                chatId: entry.chatId,
                text: `${entry.html}\n\n<i>No longer pending.</i>`,
                replyMarkup: { inline_keyboard: [] },
            }).catch(() => { })
            return { delivered: false }
        }
        entry.onAbort = () => abandon(entry, 'No longer pending.', 'the request ended before a Telegram answer arrived')
        signal.addEventListener('abort', entry.onAbort, { once: true })
        if (settings.answerTimeoutMinutes > 0) {
            entry.timer = setTimeout(() => abandon(entry, 'The Telegram prompt expired; answer it in the DSH UI.', 'the Telegram answer window closed'), settings.answerTimeoutMinutes * 60_000)
            entry.timer.unref?.()
        }
        pending.set(id, entry)
        return { delivered: true, promptId: id, promise: deferred.promise }
    }
    /**
     * Post one question prompt and return its answer promise.
     * @param request - the DSH question request.
     * @param signal - lifetime shared with the DSH ask.
     * @returns delivery result: the prompt id and its answer promise.
     */
    async function ask(request, signal) {
        const questions = Array.isArray(request?.questions) ? request.questions : []
        if (questions.length === 0)
            return { delivered: false }
        const session = request?.agent?.session
        const state = session === undefined ? undefined : stateFor(session)
        return post({
            kind: 'question',
            markdown: promptMarkdown(session, state, questions),
            keyboard: (id) => keyboardFor(id, questions),
            questions,
            signal,
        })
    }
    /**
     * Post one approval prompt with Allow/Reject buttons.
     * @param request - the DSH approval request.
     * @param signal - lifetime shared with the DSH decide.
     * @returns delivery result: the prompt id and its outcome promise.
     */
    async function askApproval(request, signal) {
        const session = request?.agent?.session
        const state = session === undefined ? undefined : stateFor(session)
        return post({
            kind: 'approval',
            markdown: approvalMarkdown(session, state, request),
            keyboard: (id) => approvalKeyboard(id),
            signal,
        })
    }
    /** Resolve an approval prompt with 'allowed-once' or 'rejected'. */
    function fulfilApproval(entry, allow) {
        if (!release(entry, allow ? '✅ Allowed once from Telegram.' : '❌ Rejected from Telegram.'))
            return
        entry.deferred.resolve(allow ? 'allowed-once' : 'rejected')
    }
    function applyApproval(promptId, allow) {
        const entry = pending.get(promptId)
        if (entry === undefined || entry.kind !== 'approval')
            return false
        fulfilApproval(entry, allow)
        return true
    }
    function recordAnswer(entry, questionIndex, answer) {
        const question = entry.questions[questionIndex]
        if (question === undefined)
            return false
        entry.answers.set(question.id, { id: question.id, ...answer })
        return true
    }
    /** Apply one option press; completes the prompt when every question is answered. */
    function applyOption(promptId, questionIndex, optionIndex) {
        const entry = pending.get(promptId)
        if (entry === undefined)
            return false
        const question = entry.questions[questionIndex]
        const option = question?.options?.[optionIndex]
        if (option === undefined)
            return false
        recordAnswer(entry, questionIndex, { selected: [option.label] })
        if (entry.answers.size >= entry.questions.length)
            fulfil(entry, 'Answered from Telegram.')
        return true
    }
    /** Parse a free-text reply into answers, or report what is still missing. */
    function applyText(entry, rawText) {
        const text = rawText.trim()
        if (text === '')
            return { ok: false, reply: 'Send the answer as text.' }
        if (entry.questions.length === 1) {
            const question = entry.questions[0]
            const match = (question.options ?? []).find((option) => snippet(option?.label, 160).toLowerCase() === text.toLowerCase())
            recordAnswer(entry, 0, match === undefined ? { selected: [], custom: text } : { selected: [match.label] })
            return { ok: true }
        }
        const lines = text.split('\n').map((line) => line.replace(/^\s*\d{1,2}[.)]\s*/, '').trim()).filter((line) => line !== '')
        if (lines.length !== entry.questions.length)
            return { ok: false, reply: `Send ${entry.questions.length} lines, one answer per question.` }
        lines.forEach((line, index) => {
            const question = entry.questions[index]
            const match = (question.options ?? []).find((option) => snippet(option?.label, 160).toLowerCase() === line.toLowerCase())
            recordAnswer(entry, index, match === undefined ? { selected: [], custom: line } : { selected: [match.label] })
        })
        return { ok: true }
    }
    /**
     * Handle one Telegram update: a button press or a text reply.
     * @param update - Bot API update object.
     * @param settings - settings captured for this poll cycle.
     */
    async function handleUpdate(update, settings) {
        const callback = update?.callback_query
        if (callback !== undefined) {
            const chatId = String(callback.message?.chat?.id ?? '')
            if (chatId !== settings.chatId || callback.from?.is_bot === true) {
                await api.answerCallbackQuery(callback.id, 'This chat is not allowed to answer.', true).catch(() => { })
                return
            }
            const data = String(callback.data ?? '')
            const approval = /^a([0-9a-z]+):([yn])$/.exec(data)
            if (approval !== null) {
                const applied = applyApproval(approval[1], approval[2] === 'y')
                await api.answerCallbackQuery(callback.id, applied ? 'Decision sent to DSH.' : 'This request is no longer pending.', !applied).catch(() => { })
                return
            }
            const question = /^q([0-9a-z]+):(\d+):(\d+)$/.exec(data)
            if (question === null) {
                await api.answerCallbackQuery(callback.id, 'Unknown answer.').catch(() => { })
                return
            }
            const applied = applyOption(question[1], Number(question[2]), Number(question[3]))
            await api.answerCallbackQuery(callback.id, applied ? 'Answer sent to DSH.' : 'This question is no longer active.', !applied).catch(() => { })
            return
        }
        const message = update?.message
        if (message === undefined || message.from?.is_bot === true)
            return
        const chatId = String(message.chat?.id ?? '')
        if (chatId !== settings.chatId)
            return
        const text = typeof message.text === 'string' ? message.text.trim() : ''
        if (text === '')
            return
        // Approvals only take a button press; a stray message must not decide one.
        const open = [...pending.values()].filter((entry) => entry.chatId === chatId && entry.kind === 'question')
        if (open.length === 0)
            return
        // A reply to a specific prompt wins; otherwise the newest prompt does.
        const quoted = message.reply_to_message?.message_id
        const entry = open.find((candidate) => candidate.messageId === quoted) ?? open[open.length - 1]
        const result = applyText(entry, text)
        if (!result.ok) {
            await api.sendMessage({
                text: `<i>${escapeXml(result.reply ?? 'Use the buttons or send text.')}</i>`,
                parseMode: 'HTML',
            }).catch(() => { })
            return
        }
        if (entry.answers.size >= entry.questions.length)
            fulfil(entry, 'Answered from Telegram.')
    }
    /** Reject every pending prompt, used on plugin dispose. */
    function dispose() {
        for (const entry of [...pending.values()])
            abandon(entry, 'Notifications stopped.', 'the Telegram plugin was disposed')
    }
    return { ask, askApproval, handleUpdate, dispose, close, pending }
}
// ─────────────────────────── reply polling ───────────────────────────
/**
 * Long-poll getUpdates while replies are enabled. The backlog is skipped on
 * start so old messages never answer a fresh question; a 409 conflict (another
 * process polls the same bot) is reported once and retried slowly.
 * @param options - settings reader, logger, Bot API client and broker.
 * @returns a function that stops the loop.
 */
export function startPoller({ readSettings, logger, api, broker }) {
    let active = true
    let offset
    let conflictLogged = false
    /** Replies are only read from a private chat: a positive numeric chat id. */
    const replyChat = (settings) => settings !== undefined
        && settings.chatId !== ''
        && settings.allowReplies
        && /^\d+$/.test(settings.chatId)
    async function prime() {
        try {
            const updates = await api.getUpdates({ offset: -1, timeout: 0 })
            offset = updates.length === 0 ? 0 : updates[updates.length - 1].update_id + 1
            return true
        }
        catch {
            return false
        }
    }
    async function run() {
        while (active) {
            const settings = readSettings()
            if (!replyChat(settings)) {
                await sleep(4000)
                continue
            }
            if (offset === undefined) {
                // Skip the backlog so old messages never answer a fresh question.
                if (!await prime()) {
                    await sleep(5000)
                    continue
                }
            }
            try {
                const updates = await api.getUpdates({ offset, timeout: POLL_TIMEOUT_SECONDS })
                if (!active)
                    return
                for (const update of updates) {
                    offset = update.update_id + 1
                    await broker.handleUpdate(update, settings)
                }
                conflictLogged = false
            }
            catch (error) {
                if (!active)
                    return
                if (error?.telegramStatus === 409) {
                    if (!conflictLogged) {
                        logger.warn('telegram-plus: getUpdates conflict — another process polls this bot; replies from Telegram stay off until it stops')
                        conflictLogged = true
                    }
                    await sleep(30_000)
                    continue
                }
                logger.warn(`telegram-plus: polling failed (${describeError(error)})`)
                await sleep(5000)
            }
        }
    }
    void run()
    return () => {
        active = false
    }
}
// ───────────────────────────── delivery ─────────────────────────────
function createDeliverer({ api, readSettings, logger }) {
    return async function deliver(source) {
        try {
            const settings = readSettings()
            if (settings === undefined || settings.chatId === '')
                return
            const text = String(source ?? '')
            if (text.trim() === '')
                return
            // Convert once, then split the HTML: splitting the markdown first
            // breaks emphasis and code fences that cross a message boundary.
            const parts = settings.format === 'plain'
                ? splitForTelegram(text).map((part) => ({ text: part, parseMode: undefined }))
                : splitTelegramHtml(toTelegramHtml(text)).map((part) => ({ text: part, parseMode: 'HTML' }))
            for (const part of parts) {
                if (part.text.trim() === '')
                    continue
                await api.sendMessage({
                    text: part.text,
                    parseMode: part.parseMode,
                    silent: settings.silent,
                })
            }
        }
        catch (error) {
            // Never include the endpoint (it carries the token) or the token itself.
            logger.warn(`telegram-plus: ${describeError(error)}`)
        }
    }
}
// ───────────────────────────── plugin ─────────────────────────────
/**
 * Keep the custom client page as the only settings surface. The Host can
 * otherwise auto-generate a plain form from `Config`; that form would expose
 * the literal `token` field, which we deliberately replace with credential
 * storage in the custom page.
 */
function hideAutoSettingsPage(ctx) {
    ctx.inject(['settings'], (settingsCtx) => {
        const settings = settingsCtx.settings
        if (typeof settings?.configure !== 'function')
            return
        settingsCtx.effect(() => {
            try {
                return settings.configure({ auto: false }, ctx.fiber)
            }
            catch {
                return () => { }
            }
        }, 'telegram-plus: custom settings page')
    })
}
/**
 * Register session-event handlers and the question answerer. Must never throw
 * into the agent: every handler body is isolated and sends are asynchronous.
 * @param ctx - Cordis context with `credentials` injected.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
    const logger = ctx.logger(name)
    hideAutoSettingsPage(ctx)
    // Volatile config fields stay live without a remount, so read them at the
    // moment of use instead of snapshotting the value from `apply`.
    const readSettings = () => resolveSettings(config)
    const initial = readSettings()
    if (initial === undefined) {
        logger.warn('telegram-plus: unusable configuration (check apiBase and tokenRef); notifications stay disabled')
    }
    else if (initial.chatId === '') {
        logger.warn('telegram-plus: chatId is not configured; notifications stay disabled')
    }
    const api = createApi({ ctx, readSettings, logger })
    const deliver = createDeliverer({ api, readSettings, logger })
    const sessions = new WeakMap()
    /** Pending settle timers, keyed by `tool:<callId>` or `approval:<id>`. */
    const timers = new Map()
    function stateFor(session) {
        let state = sessions.get(session)
        if (state === undefined) {
            state = {
                title: '',
                user: '',
                // Last non-empty assistant text of the current run.
                assistant: '',
                // Whether a message the human typed started the current run.
                human: false,
                // The next user/message of this turn is its waking message.
                awaitingWake: false,
                // Pending 'the task finished' timer.
                completion: undefined,
                // Generation token so a superseded timer never reports.
                token: undefined,
            }
            sessions.set(session, state)
        }
        return state
    }
    const broker = createBroker({ readSettings, logger, api, stateFor })
    function cancel(key) {
        const timer = timers.get(key)
        if (timer !== undefined) {
            clearTimeout(timer)
            timers.delete(key)
        }
    }
    function settle(key, text, delayMs) {
        cancel(key)
        const timer = setTimeout(() => {
            timers.delete(key)
            void deliver(text)
        }, delayMs)
        timer.unref?.()
        timers.set(key, timer)
    }
    /** States whose completion timer is still running, so dispose can clear them. */
    const pendingCompletions = new Set()
    function cancelCompletion(state) {
        if (state.completion !== undefined) {
            clearTimeout(state.completion)
            state.completion = undefined
        }
        pendingCompletions.delete(state)
        state.token = undefined
    }
    /** Exact live agent of a root session, when the registry is available. */
    function currentAgent(session) {
        try {
            const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
            return agents?.get?.(session.id)
        }
        catch {
            return undefined
        }
    }
    /** Send the run's answer once; a stale token means a newer turn superseded it. */
    function sendCompletion(session, state, token) {
        if (state.token !== token)
            return
        state.token = undefined
        state.human = false
        const text = formatCompleted(session, state)
        if (text !== '')
            void deliver(text)
    }
    /**
     * The run went quiet: report its final answer once. A run the human started
     * always reports (unless completion messages are off); an unattended run
     * reports only when notifyBackground is on, so scheduled checks do not fill
     * the chat with 'nothing new'. While subagents (a team, a delegated child)
     * are still working the task is not over, so the message waits for them.
     */
    function finishTask(session, state) {
        const token = state.token
        state.completion = undefined
        pendingCompletions.delete(state)
        const settings = readSettings()
        if (settings === undefined || settings.chatId === '') {
            state.token = undefined
            state.human = false
            return
        }
        // Each switch owns its own kind of run, so turning off 'Task finished'
        // does not also silence the background toggle and the other way round.
        if (state.human && !settings.notifyTurnComplete) {
            state.token = undefined
            state.human = false
            return
        }
        if (!state.human && !settings.notifyBackground) {
            state.token = undefined
            return
        }
        const agent = currentAgent(session)
        const subagents = typeof ctx.get === 'function' ? ctx.get('subagents') : undefined
        if (agent !== undefined && typeof subagents?.waitForChildren === 'function') {
            try {
                void Promise.resolve(subagents.waitForChildren(agent)).then((joined) => {
                    if (state.token !== token)
                        return
                    if (joined)
                        scheduleCompletion(session, state)
                    else
                        sendCompletion(session, state, token)
                }, () => sendCompletion(session, state, token))
                return
            }
            catch (error) {
                logger.warn(`telegram-plus: could not wait for child work (${describeError(error)})`)
            }
        }
        sendCompletion(session, state, token)
    }
    /**
     * Give the agent a short quiet window before announcing the result: a turn
     * that continues immediately (auto-continuation, a queued follow-up) is the
     * same task, and only the last answer is worth a message.
     */
    function scheduleCompletion(session, state) {
        cancelCompletion(state)
        const token = {}
        state.token = token
        const timer = setTimeout(() => {
            try {
                if (state.token === token)
                    finishTask(session, state)
            }
            catch (error) {
                logger.warn(`telegram-plus: could not report the finished task (${describeError(error)})`)
            }
        }, COMPLETION_SETTLE_MS)
        timer.unref?.()
        state.completion = timer
        pendingCompletions.add(state)
    }
    function onToolCall(session, state, data) {
        const settings = readSettings()
        if (settings === undefined || settings.chatId === '')
            return
        if (typeof data.callId !== 'string')
            return
        // With replies on, the question waterfall posts the answerable prompt,
        // so these plain notifications would duplicate it.
        const answerable = settings.allowReplies && /^\d+$/.test(settings.chatId)
        if (data.name === 'ask_user_question') {
            if (answerable)
                return
            const questions = questionsFromArguments(data.arguments)
            if (questions.length === 0)
                return
            const plan = planFromQuestions(questions)
            if (plan !== '') {
                if (!settings.notifyPlanReviews)
                    return
                settle(`tool:${data.callId}`, formatPlan(session, state, plan), QUESTION_SETTLE_MS)
                return
            }
            if (!settings.notifyQuestions)
                return
            settle(`tool:${data.callId}`, formatQuestions(session, state, questions), QUESTION_SETTLE_MS)
            return
        }
        if (data.name === 'exit_plan_mode') {
            if (answerable || !settings.notifyPlanReviews)
                return
            const plan = parseArguments(data.arguments)?.plan
            if (typeof plan !== 'string' || plan.trim() === '')
                return
            settle(`tool:${data.callId}`, formatPlan(session, state, plan), QUESTION_SETTLE_MS)
        }
    }
    function onTurnEnd(session, state, data) {
        const settings = readSettings()
        if (settings === undefined || settings.chatId === '')
            return
        const reason = data.reason
        const kind = reason.kind
        if (kind === 'completed') {
            // Not a message yet: a follow-up turn of the same run cancels it.
            scheduleCompletion(session, state)
            return
        }
        // A turn that stopped badly is its own news and must not be followed by
        // a stale completion for an earlier turn of the same run.
        cancelCompletion(state)
        state.human = false
        if (kind === 'error') {
            if (settings.notifyTurnError)
                void deliver(formatError(session, state, reason.error))
            return
        }
        if (kind === 'max-tokens' || kind === 'blocked') {
            if (settings.notifyTurnError)
                void deliver(formatWarning(session, state, kind))
            return
        }
        if (kind === 'aborted') {
            if (settings.notifyTurnAborted)
                void deliver(formatAborted(session, state, reason))
        }
    }
    function onSessionEvent(session, event) {
        try {
            if (!isRootSession(session) || typeof event?.type !== 'string')
                return
            const state = stateFor(session)
            switch (event.type) {
                case 'session/title': {
                    const title = event.data.title
                    if (typeof title === 'string')
                        state.title = title
                    return
                }
                case 'turn/start':
                    state.awaitingWake = true
                    cancelCompletion(state)
                    return
                case 'user/message': {
                    const kind = event.data.source?.kind
                    const waking = state.awaitingWake === true
                    if (waking)
                        state.awaitingWake = false
                    if (kind === 'user') {
                        // A fresh human prompt starts a fresh task.
                        state.human = true
                        state.assistant = ''
                        const text = messageText(event.data)
                        if (text !== '')
                            state.user = text
                        return
                    }
                    // A scheduled/background run that starts its own turn must not
                    // report the previous task's answer.
                    if (waking && !state.human)
                        state.assistant = ''
                    return
                }
                case 'assistant/message': {
                    const text = messageText(event.data.message)
                    if (text !== '')
                        state.assistant = text
                    return
                }
                case 'turn/end':
                    onTurnEnd(session, state, event.data)
                    return
                case 'tool/call':
                    onToolCall(session, state, event.data)
                    return
                case 'tool/result': {
                    const callId = event.data.message.toolCallId
                    if (typeof callId === 'string')
                        cancel(`tool:${callId}`)
                    return
                }
                case 'approval/asked': {
                    const settings = readSettings()
                    if (settings === undefined || settings.chatId === '' || !settings.notifyApprovals)
                        return
                    // With replies on, the approval waterfall posts the buttons.
                    if (settings.allowReplies && /^\d+$/.test(settings.chatId))
                        return
                    const id = event.data.id
                    if (typeof id !== 'string')
                        return
                    settle(`approval:${id}`, formatApproval(session, state, event.data), APPROVAL_SETTLE_MS)
                    return
                }
                case 'approval/decided': {
                    const id = event.data.id
                    if (typeof id !== 'string')
                        return
                    cancel(`approval:${id}`)
                    return
                }
            }
        }
        catch (error) {
            logger.warn(`telegram-plus: event handling failed (${describeError(error)})`)
        }
    }
    /**
     * Answer a pending question from Telegram while the browser answerer keeps
     * its card. Whichever settles first wins; the loser is cancelled through
     * the shared abort signal, so a question is never answerable twice.
     */
    function onQuestionRequest(request, next) {
        const settings = readSettings()
        if (settings === undefined || settings.chatId === '' || !settings.allowReplies)
            return next()
        if (!/^\d+$/.test(settings.chatId))
            return next()
        if (request?.wait !== undefined)
            return next()
        if (!Array.isArray(request?.questions) || request.questions.length === 0)
            return next()
        const planReview = request.questions.some((question) => question?.intent?.kind === 'plan-review')
        if (planReview ? !settings.notifyPlanReviews : !settings.notifyQuestions)
            return next()
        const inherited = request.signal
        if (inherited?.aborted)
            return next()
        const lifetime = new AbortController()
        const linked = inherited === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, inherited])
        request.signal = linked
        const downstream = Promise.resolve().then(() => next())
        downstream.catch(() => { })
        return broker.ask(request, linked).then((delivered) => {
            if (!delivered.delivered) {
                return downstream
            }
            const answer = delivered.promise
            answer.catch(() => { })
            const fallback = downstream.catch((error) => {
                if (error?.code === 'NO_PROVIDER')
                    return STANDSTILL
                throw error
            })
            const outcome = Promise.race([
                answer.then((value) => ({ from: 'telegram', value })),
                fallback.then((value) => (value === STANDSTILL ? { from: 'standstill' } : { from: 'ui', value })),
            ])
            return outcome.then((settled) => {
                if (settled.from === 'standstill')
                    return answer
                if (settled.from === 'telegram') {
                    // The UI branch keeps a pending card until its signal aborts.
                    lifetime.abort(abortReason('answered from Telegram'))
                    return settled.value
                }
                broker.close(delivered.promptId, 'Answered in the DSH UI.')
                lifetime.abort(abortReason('answered in the DSH UI'))
                return settled.value
            }, (error) => {
                broker.close(delivered.promptId, 'No longer pending.')
                throw error
            })
        })
    }
    ctx.on('user-questions/request', onQuestionRequest, { global: true, prepend: true })
    /**
     * Answer a pending tool approval from Telegram while the browser dialog
     * keeps its card. The UI chain answers 'unavailable' when no client is
     * attached, which keeps the Telegram prompt waiting instead of failing the
     * request closed.
     */
    function onApprovalRequest(request, next) {
        const settings = readSettings()
        if (settings === undefined || settings.chatId === '' || !settings.allowReplies || !settings.notifyApprovals)
            return next()
        if (!/^\d+$/.test(settings.chatId))
            return next()
        const inherited = request?.signal
        if (inherited?.aborted)
            return 'cancelled'
        const lifetime = new AbortController()
        const linked = inherited === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, inherited])
        request.signal = linked
        const downstream = Promise.resolve().then(() => next())
        downstream.catch(() => { })
        return broker.askApproval(request, linked).then((delivered) => {
            if (!delivered.delivered)
                return downstream
            const answer = delivered.promise
            answer.catch(() => { })
            const fallback = downstream.then(
                (outcome) => (outcome === 'unavailable' ? STANDSTILL : outcome),
                () => STANDSTILL,
            )
            const outcome = Promise.race([
                answer.then((value) => ({ from: 'telegram', value })),
                fallback.then((value) => (value === STANDSTILL ? { from: 'standstill' } : { from: 'ui', value })),
            ])
            return outcome.then((settled) => {
                if (settled.from === 'standstill')
                    return answer
                if (settled.from === 'telegram') {
                    lifetime.abort(abortReason('decided from Telegram'))
                    return settled.value
                }
                broker.close(delivered.promptId, 'Decided in the DSH UI.')
                lifetime.abort(abortReason('decided in the DSH UI'))
                return settled.value
            }, (error) => {
                broker.close(delivered.promptId, 'No longer pending.')
                throw error
            })
        })
    }
    ctx.on('approval/request', onApprovalRequest, { global: true, prepend: true })
    ctx.on('session/event', onSessionEvent)
    ctx.effect(() => () => {
        for (const state of [...pendingCompletions])
            cancelCompletion(state)
        for (const timer of timers.values())
            clearTimeout(timer)
        timers.clear()
        broker.dispose()
    }, 'telegram-plus: pending notifications and questions')
    ctx.effect(() => {
        const stop = startPoller({ readSettings, logger, api, broker })
        return () => stop()
    }, 'telegram-plus: reply polling')
}
