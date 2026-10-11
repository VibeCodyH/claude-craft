import { atom, read, update } from 'claude-code'
import type { Register, RenderElement } from 'claude-code'

import type { Handoff } from '../types'

// Clipboard step: when a Bash call writes the clipboard (wl-copy), read back
// what is actually on it and show it above the prompt until the next prompt.
// The band shows the real clipboard, not a guess parsed from the command.

const handoff = atom({ plugin: 'clipboard-step', key: 'handoff' } as const, null)
const WRITES_CLIPBOARD = /\bwl-copy\b/
const norm = (s: string) => s.replace(/^\s*!\s*/, '').trim()

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (!WRITES_CLIPBOARD.test(String(e.command ?? ''))) return ran
    if (ran.deny !== undefined || ran.isError === true) return ran

    const pasted = await $.process.run(['wl-paste', '-n'])
    const text = pasted.exitCode === 0 ? pasted.stdout : ''
    if (text.trim() !== '') {
      const lines = text.split('\n').filter(l => l.trim() !== '').length
      await update($, handoff, () => ({ text, lines, at: Date.now() }) satisfies Handoff)
    } else {
      // Cleared on purpose (wl-copy --clear): nothing staged, so no band.
      await update($, handoff, () => null)
    }
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, handoff, () => null)
    return next(e)
  })

  // A `!` run never fires prompt.submit, so the band used to outlive the step
  // and the same command read as a new one. Pasting the staged text into the
  // prompt is the person taking it: the band goes. The editor may eat the
  // leading `!` as the mode switch, so compare without it.
  on('prompt.edit', async ($, e, next) => {
    const pastedText = norm(e.inputText ?? '')
    if (pastedText !== '') {
      await update($, handoff, h => (h && norm(h.text).includes(pastedText) && pastedText.length >= Math.min(12, norm(h.text).length) ? null : h))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const h = await read($, handoff)
    if (!h) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const first = h.text.split('\n').find(l => l.trim() !== '')?.trim() ?? ''
    const room = Math.max(20, (e.props.bodyColumns ?? 80) - 26)
    const isCommand = first.startsWith('!')
    const what = h.lines > 1 ? `${h.lines} lines, starts:` : isCommand ? 'run with ! :' : ''

    const children = [
      Text({ color: 'cyan', bold: true, children: '📋 On your clipboard ' }),
      Text({ dimColor: true, children: what ? `${what} ` : '' }),
      Text({ color: isCommand ? 'green' : undefined, wrap: 'truncate-end', children: clip(first, room) }),
    ]
    const row = Box({ key: 'clipboard-step', flexDirection: 'row', paddingX: 1, children })
    return stack(Box, row, await next(e))
  })
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s
}

// Another mod (or the engine) may draw in the band too: keep both, ours on top.
function stack(Box: (p: never) => unknown, mine: unknown, below: unknown): RenderElement {
  return (below ? Box({ flexDirection: 'column', children: [mine, below] } as never) : mine) as RenderElement
}
