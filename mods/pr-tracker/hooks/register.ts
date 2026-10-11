import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { Pr } from '../types'
import { FIELDS, JQ, detect, isRefresh, keyOf, summarize } from './pr'
import type { Raw, Target } from './pr'

// PR tracker: the PR this session is babysitting, pinned above the prompt with
// its review verdict, checks and merge state. A PR joins when babysit starts
// its watcher, when this session opens it, or when a review is re-requested;
// it leaves 10 minutes after it merges or closes. Display only: it reads
// `gh pr view` and never changes a command.

const prs = atom({ plugin: 'pr-tracker', key: 'prs' } as const, [] as Pr[])

const POLL_MS = 60_000
const SETTLE_MS = 20_000 // a push's checks take a moment to register
const HOLD_MS = 10 * 60_000
const MAX_ROWS = 4

const TONE = { good: 'green', bad: 'red', wait: 'yellow', dim: 'gray', done: 'magenta' } as const
const DOT = { good: '●', bad: '✗', wait: '◐', dim: '○', done: '●' } as const

// Module variables start over on a hot reload; the list in $.state does not,
// so session.start (which fires again on reload) restarts the poll.
let timer: Timer | null = null
let busy = false

function ensureTimer($: EngineInterface) {
  timer ??= $.clock.every(POLL_MS, () => void pollAll($))
}

async function pollAll($: EngineInterface) {
  if (busy) return
  busy = true
  try {
    const list = await read($, prs)
    if (list.length === 0) return
    const fresh = await Promise.all(list.filter(p => p.endedAt === null).map(p => fetchOne($, p)))
    const now = await $.clock.now()
    await update($, prs, cur =>
      cur
        .map(p => fresh.find(f => keyOf(f) === keyOf(p)) ?? p)
        .filter(p => p.endedAt === null || now - p.endedAt < HOLD_MS),
    )
  } finally {
    busy = false
  }
}

async function track($: EngineInterface, targets: Target[]) {
  const have = new Set((await read($, prs)).map(keyOf))
  const added = targets.filter(t => !have.has(keyOf(t))).map(blank)
  if (added.length === 0) return
  await update($, prs, cur => [...cur, ...added.filter(a => !cur.some(p => keyOf(p) === keyOf(a)))])
  ensureTimer($)
  const fresh = await Promise.all(added.map(p => fetchOne($, p)))
  await update($, prs, cur => cur.map(p => fresh.find(f => keyOf(f) === keyOf(p)) ?? p))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if ((await read($, prs)).length > 0) {
      ensureTimer($)
      void pollAll($)
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')
    const maybeTrack = /watch-review\.sh|\bgh\s+pr\s+(create|edit)\b/.test(command)
    const refresh = isRefresh(command)
    if (!maybeTrack && !refresh) return next(e)

    const ran = await next(e)
    try {
      if (ran.deny === undefined) {
        const stdout = String((ran.result as { stdout?: unknown } | undefined)?.stdout ?? '')
        if (maybeTrack) await track($, detect(command, stdout))
        if (refresh && (await read($, prs)).length > 0) {
          void pollAll($)
          $.clock.after(SETTLE_MS, () => void pollAll($))
        }
      }
    } catch (err) {
      $.ui.log(`pr-tracker: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
    }
    return ran
  }).catch(($, e, next) => next(e)) // display only: never stands between a command and its run

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, prs)
    if (list.length === 0) return next(e)

    const { Box, Text, Link } = $.ui.resolve(e)
    const width = e.props.bodyColumns ?? 100
    const rows = list.slice(-MAX_ROWS).map(p => {
      const parts: unknown[] = [
        Text({ dimColor: true, children: '⎇ ' }),
        Link({ href: `https://github.com/${p.repo}/pull/${p.number}`, children: [`${short(p.repo)}#${p.number}`] }),
      ]
      if (p.error) {
        parts.push(Text({ color: 'red', wrap: 'truncate-end', children: `  ⚠ ${p.error}` }))
      } else if (!p.verdict) {
        parts.push(Text({ dimColor: true, children: '  …' }))
      } else {
        parts.push(Text({ color: TONE[p.verdict.tone], children: `  ${DOT[p.verdict.tone]} ${p.verdict.label}` }))
        const c = p.checks
        if (c && p.state === 'OPEN') {
          parts.push(Text({ dimColor: true, children: '  checks' }))
          if (c.pass) parts.push(Text({ color: 'green', children: ` ${c.pass}✓` }))
          if (c.fail) parts.push(Text({ color: 'red', children: ` ${c.fail}✗ ${c.failing.slice(0, 2).join(', ')}` }))
          if (c.pending) parts.push(Text({ color: 'yellow', children: ` ${c.pending}◌` }))
        }
        if (p.merge === 'behind') parts.push(Text({ color: 'yellow', children: '  behind' }))
        if (p.merge === 'conflicts') parts.push(Text({ color: 'red', bold: true, children: '  conflicts' }))
      }
      parts.push(Text({ dimColor: true, wrap: 'truncate-end', children: `  ${clip(p.title, Math.max(10, width - 70))}` }))
      return Box({ flexDirection: 'row', paddingX: 1, children: parts as never })
    })

    const mine = Box({ key: 'pr-tracker', flexDirection: 'column', children: rows as never })
    const below = await next(e)
    return (below ? Box({ flexDirection: 'column', children: [mine, below] } as never) : mine) as RenderElement
  })
}

async function fetchOne($: EngineInterface, p: Pr): Promise<Pr> {
  try {
    const r = await $.process.run(
      ['gh', 'pr', 'view', String(p.number), '-R', p.repo, '--json', FIELDS, '--jq', JQ],
      { timeoutMs: 20_000 },
    )
    if (r.exitCode !== 0) return { ...p, error: firstLine(r.stderr) || `gh exited ${r.exitCode}` }
    const s = summarize(JSON.parse(r.stdout) as Raw)
    const ended = s.state !== 'OPEN'
    return { ...p, ...s, error: null, endedAt: ended ? (p.endedAt ?? (await $.clock.now())) : null }
  } catch (err) {
    return { ...p, error: firstLine(err instanceof Error ? err.message : String(err)) }
  }
}

function blank(t: Target): Pr {
  return {
    repo: t.repo,
    number: t.number,
    title: '',
    state: null,
    verdict: null,
    checks: null,
    merge: null,
    head: '',
    error: null,
    endedAt: null,
  }
}

function short(repo: string): string {
  return repo.split('/')[1] ?? repo
}

function firstLine(s: string): string {
  return s.trim().split('\n')[0]?.slice(0, 120) ?? ''
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s
}
