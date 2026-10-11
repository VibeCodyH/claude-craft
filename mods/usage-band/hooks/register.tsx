import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Snapshot, Window } from '../types'

const snap = atom({ plugin: 'usage-band', key: 'snap' } as const, null)

const REFRESH_MS = 60_000
const MAX_READ_BYTES = 3_500_000
const DAY_MS = 86_400_000

const pad = (n: number) => String(n).padStart(2, '0')

export function countdown(resetsAt: number, now: number): string {
  const remaining = Math.floor((resetsAt - now) / 1000)
  if (remaining <= 0) return 'ready'
  const days = Math.floor(remaining / 86400)
  const hours = Math.floor((remaining % 86400) / 3600)
  const minutes = Math.floor((remaining % 3600) / 60)
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${minutes}m`
  return `${Math.max(minutes, 1)}m`
}

// % left → green / amber / red (same thresholds as ghostty-cockpit).
export function pctColor(left: number): string {
  if (left <= 10) return '#ff5f5f'
  if (left <= 30) return '#d7d787'
  return '#5fd787'
}

type CodexLimit = {
  used_percent?: number
  window_minutes?: number
  resets_at?: number
  resets_in_seconds?: number
}

// Finds the newest token_count rate-limit reading in a Codex session log.
export function parseCodex(text: string): Snapshot['codex'] {
  const out: Snapshot['codex'] = { fiveHour: null, weekly: null }
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.includes('"token_count"') || !line.includes('rate_limits')) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const limits = row?.payload?.type === 'token_count' ? row.payload.rate_limits : null
    if (!limits) continue
    const stampMs = row.timestamp ? Date.parse(row.timestamp) : NaN
    const slots: [CodexLimit | undefined, 'fiveHour' | 'weekly'][] = [
      [limits.primary, 'fiveHour'],
      [limits.secondary, 'weekly'],
    ]
    for (const [limit, fallback] of slots) {
      if (!limit || typeof limit.used_percent !== 'number') continue
      const resetsAt =
        typeof limit.resets_at === 'number'
          ? limit.resets_at * 1000
          : typeof limit.resets_in_seconds === 'number' && !Number.isNaN(stampMs)
            ? stampMs + limit.resets_in_seconds * 1000
            : 0
      const slot =
        typeof limit.window_minutes === 'number'
          ? limit.window_minutes <= 360
            ? 'fiveHour'
            : 'weekly'
          : fallback
      out[slot] = { left: Math.round(100 - limit.used_percent), resetsAt }
    }
    if (out.fiveHour || out.weekly) return out
  }
  return out
}

async function readCodex($: EngineInterface, home: string, now: number): Promise<Snapshot['codex']> {
  const root = `${home}/.codex/sessions`
  let newest: { path: string; mtimeMs: number; size: number } | null = null
  // Codex files sessions by local date; scan around today in case the
  // engine's clock zone differs, then fall back up to a week.
  for (let offset = 1; offset >= -7; offset--) {
    const d = new Date(now + offset * DAY_MS)
    const dir = `${root}/${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
    const entries = await $.fs.list(dir).catch(() => [])
    for (const entry of entries) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
      if (!newest || entry.mtimeMs > newest.mtimeMs) {
        newest = { path: `${dir}/${entry.name}`, mtimeMs: entry.mtimeMs, size: entry.size }
      }
    }
    if (newest && offset <= -1) break
  }
  if (!newest) return { fiveHour: null, weekly: null }

  let text = ''
  if (newest.size <= MAX_READ_BYTES) {
    text = await $.fs.read(newest.path).catch(() => '')
  } else {
    const r = await $.process.run(['tail', '-n', '2000', newest.path]).catch(() => null)
    text = r?.stdout ?? ''
  }
  return parseCodex(text)
}

// The NEXT segment's file (the `nextFile` option): JSON with `next_date` and
// `next_text`. Unset hides the segment.
let nextFile = ''

export function parseNext(raw: string): string | null {
  try {
    const next = JSON.parse(raw)
    if (!next.next_text) return null
    return `${next.next_date ?? ''}  ${next.next_text}`.trim()
  } catch {
    return null
  }
}

async function readNext($: EngineInterface, home: string): Promise<string | null> {
  if (!nextFile) return null
  const raw = await $.fs.read(nextFile.replace(/^~(?=\/)/, home)).catch(() => null)
  return raw ? parseNext(raw) : null
}

// Local date and time from the host's `date`: the mod's own environment has no time zone.
async function readClock($: EngineInterface): Promise<string | null> {
  const r = await $.process.run(['date', '+%a %b %-d  %-I:%M %p']).catch(() => null)
  return r && r.exitCode === 0 ? r.stdout.trim() || null : null
}

export function claudeWindows(limits: SessionRateLimit[]): Snapshot['claude'] {
  const pick = (kind: string): Window | null => {
    const l = limits.find(x => x.kind === kind)
    if (!l) return null
    return { left: Math.round(100 - l.percentUsed), resetsAt: l.resetsAt ? Date.parse(l.resetsAt) : 0 }
  }
  return { fiveHour: pick('five_hour'), weekly: pick('seven_day') }
}

async function refresh($: EngineInterface) {
  const now = await $.clock.now()
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  const [codex, next, usage, clock] = await Promise.all([
    readCodex($, home, now).catch(() => ({ fiveHour: null, weekly: null })),
    readNext($, home),
    $.session.usage().catch(() => null),
    readClock($),
  ])
  const percent = usage?.context.percent
  const value: Snapshot = {
    at: now,
    next,
    clock,
    codex,
    claude: claudeWindows(usage?.rateLimits ?? []),
    contextLeft: typeof percent === 'number' ? 100 - percent : null,
  }
  await update($, snap, () => value)
}

export const register: Register = (on, options) => {
  nextFile = String(options?.nextFile ?? '').trim()
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const now = await refresh($).then(() => $.clock.now()).catch(() => 0)
    // Start the minute ticks on the minute so the clock never runs behind.
    $.clock.after(REFRESH_MS - (now % REFRESH_MS), () => {
      refresh($).catch(() => {})
      $.clock.every(REFRESH_MS, () => {
        refresh($).catch(() => {})
      })
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await refresh($).catch(() => {})
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snap)
    if (e.props.hasSurvey || s === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const sep = <Text color="#5a5a6e"> │ </Text>
    const win = (label: string, w: Window | null) =>
      w === null ? (
        <Text>
          <Text color="#87d7ff">{label} </Text>
          <Text color="#8a8a8a">—</Text>
        </Text>
      ) : (
        <Text>
          <Text color="#87d7ff">{label} </Text>
          <Text color={pctColor(w.resetsAt && w.resetsAt <= s.at ? 100 : w.left)}>
            {w.resetsAt && w.resetsAt <= s.at ? 100 : w.left}%
          </Text>
          <Text color="#8a8a8a"> {w.resetsAt ? countdown(w.resetsAt, s.at) : '—'}</Text>
        </Text>
      )

    return (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" flexWrap="wrap" flexShrink={1}>
          {nextFile && (
            <Text color="#c05cbf" bold wrap="truncate-end">
              {s.next ? `NEXT ${s.next}` : 'NEXT —'}
            </Text>
          )}
          {nextFile && sep}
          <Text>
            <Text color="#26c6c8" bold>CDX </Text>
            {win('7D', s.codex.weekly)}
          </Text>
          {sep}
          <Text>
            <Text color="#c05cbf" bold>CLD </Text>
            {win('5H', s.claude.fiveHour)}
            <Text color="#5a5a6e"> · </Text>
            {win('7D', s.claude.weekly)}
          </Text>
          {sep}
          <Text>
            <Text color="#87d7ff">CTX </Text>
            {s.contextLeft === null ? (
              <Text color="#8a8a8a">—</Text>
            ) : (
              <Text color={pctColor(s.contextLeft)}>{s.contextLeft}% left</Text>
            )}
          </Text>
        </Box>
        {s.clock ? (
          <Box flexShrink={0} marginLeft={2}>
            <Text color="#8a8a8a">{s.clock}</Text>
          </Box>
        ) : null}
      </Box>
    )
  })
}
