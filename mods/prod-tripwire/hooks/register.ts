import { atom, read, update } from 'claude-code'
import type { Register, RenderElement } from 'claude-code'

import type { ProdTouch } from '../types'

// Prod tripwire: display only. A Bash call that touches production gets a red
// PROD band above the prompt while it runs, then a dim "last prod touch" line
// until the next prompt. It never blocks or changes a command; the hard rules
// stay in settings hooks.

const running = atom({ plugin: 'prod-tripwire', key: 'running' } as const, null)
const last = atom({ plugin: 'prod-tripwire', key: 'last' } as const, null)

// First match wins; the label is what the band says. Add your own (a prod
// read script, your prod hostname) with the `patterns` option.
const PROD: Array<[RegExp, string]> = [
  [/db:migrate:prod/, 'prod MIGRATION'],
  [/\bneonctl\b/, 'Neon'],
  [/--environment[= ]production|--prod\b/, 'Vercel production'],
  [/\bgh pr merge\b/, 'PR merge'],
]

// `label=regex` entries separated by `;;`, e.g. `prod DB=psql .*prod-db;;site=example\.com`.
// An entry with an empty regex, or one that does not compile, is skipped.
export function parsePatterns(v: unknown): Array<[RegExp, string]> {
  const out: Array<[RegExp, string]> = []
  for (const entry of String(v ?? '').split(';;')) {
    const at = entry.indexOf('=')
    const re = entry.slice(at + 1).trim()
    if (at < 1 || !re) continue
    try {
      out.push([new RegExp(re), entry.slice(0, at).trim()])
    } catch {}
  }
  return out
}

export function classify(command: string, patterns: Array<[RegExp, string]> = PROD): string | null {
  for (const [re, label] of patterns) if (re.test(command)) return label
  return null
}

export const register: Register = (on, options) => {
  const patterns = [...parsePatterns(options?.patterns), ...PROD]
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const label = classify(String(e.command ?? ''), patterns)
    if (label === null) return next(e)

    const touch: ProdTouch = { label, command: oneLine(String(e.command)), at: Date.now() }
    await update($, running, () => touch)
    try {
      const ran = await next(e)
      const failed = ran.deny !== undefined || ran.isError === true
      await update($, last, () => ({ ...touch, failed }))
      return ran
    } finally {
      await update($, running, () => null)
    }
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, last, () => null)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const now = await read($, running)
    const done = await read($, last)
    if (!now && !done) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const room = Math.max(20, (e.props.bodyColumns ?? 80) - 30)

    if (now) {
      return stack(Box, Box({
        key: 'prod-tripwire',
        flexDirection: 'row',
        paddingX: 1,
        children: [
          Text({ backgroundColor: 'red', color: 'white', bold: true, children: ' ⚠ PROD ' }),
          Text({ color: 'red', bold: true, children: `  ${now.label}` }),
          Text({ dimColor: true, wrap: 'truncate-end', children: `  ${clip(now.command, room)}` }),
        ],
      }), await next(e))
    }

    return stack(Box, Box({
      key: 'prod-tripwire',
      flexDirection: 'row',
      paddingX: 1,
      children: [
        Text({ color: done!.failed ? 'red' : 'yellow', children: done!.failed ? '✗ ' : '◆ ' }),
        Text({ dimColor: true, children: `last PROD touch at ${clock(done!.at)}: ${done!.label}` }),
        Text({ dimColor: true, wrap: 'truncate-end', children: `  ${clip(done!.command, room - 20)}` }),
      ],
    }), await next(e))
  })
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s
}

function clock(ms: number): string {
  const d = new Date(ms)
  const h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${((h + 11) % 12) + 1}:${m}${h < 12 ? 'am' : 'pm'}`
}

// Another mod (or the engine) may draw in the band too: keep both, ours on top.
function stack(Box: (p: never) => unknown, mine: unknown, below: unknown): RenderElement {
  return (below ? Box({ flexDirection: 'column', children: [mine, below] } as never) : mine) as RenderElement
}
