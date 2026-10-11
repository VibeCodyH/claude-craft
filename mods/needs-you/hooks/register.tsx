import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Ask, AskKind } from '../types'

// Needed from you: while Claude waits on you (a question, a command or a SQL
// query to run), an amber pill sits above the prompt. Opening it lists each ask
// with a copy button, so nothing said mid-turn gets lost in the scrollback.
// Claude adds asks with the `ask` tool and clears them with `resolve`; you can
// clear one with Done.

const asks = atom({ plugin: 'needs-you', key: 'asks' } as const, [] as Ask[])
const isOpen = atom({ plugin: 'needs-you', key: 'isOpen' } as const, false)

const AMBER = '#ffb000'
const KINDS: readonly AskKind[] = ['question', 'run', 'sql', 'shell']
const LABEL: Record<AskKind, string> = {
  question: 'QUESTION', run: 'RUN IN SESSION', sql: 'SQL', shell: 'RUN IN A TERMINAL',
}

const ASK_TOOL = 'mcp__needs-you__ask'
const RESOLVE_TOOL = 'mcp__needs-you__resolve'

// Parallel asks in one turn can land in the same millisecond.
let seq = 0

const GUIDE = [
  'Needed-from-you queue: the user often misses text written mid-turn, so every time you need',
  'something from them (a question to answer, a command to run with `!` in this session, a SQL',
  'query, a command for another terminal) call `mcp__needs-you__ask` with it, in addition to',
  'writing it in your reply. Put the exact text to paste in `command` (without the `!`).',
  'Call `mcp__needs-you__resolve` with its id once they have answered or run it.',
].join(' ')

// What the copy button puts on the clipboard: in-session runs get the `!` prefix.
export function copyText(ask: Ask): string {
  const command = ask.command ?? ''
  return ask.kind === 'run' && !command.startsWith('!') ? `! ${command}` : command
}

export function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ''} ago`
}

async function remove($: EngineInterface, id: string) {
  await update($, asks, list => list.filter(a => a.id !== id))
}

async function copy($: EngineInterface, ask: Ask, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface']) {
  const done = await $.ui.copy({ text: copyText(ask), surface })
  $.ui.toast(done.isCopied ? 'Copied. Paste it at the prompt.' : 'Could not copy on this surface.')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'ask',
      description: 'Queue something Claude needs from the user (a question, or a command / SQL for them to run) in the amber "needed from you" pill above their prompt, so they see it even if it scrolled past mid-turn. Returns the ask id.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: KINDS, description: 'question: they answer in chat. run: a command they run in THIS session with `!`. sql: a query they run themselves. shell: a command for another terminal.' },
          text: { type: 'string', description: 'One or two plain sentences: what you need and why.' },
          command: { type: 'string', description: 'The exact text to paste, for run/sql/shell (no leading `!`).' },
        },
        required: ['kind', 'text'],
      },
    })
    await $.tool.register({
      name: 'resolve',
      description: 'Clear an ask from the "needed from you" pill once the user answered or ran it.',
      isDeferred: false,
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    })
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'needs-you:guide', text: GUIDE, scope: 'session' as const }] }
  })

  on('tool.call', { tool: ASK_TOOL }, async ($, e) => {
    try {
      // The model's arguments sit on the event itself, as Read's `file_path` does.
      const input = e as unknown as { kind?: string; text?: string; command?: string }
      const kind = KINDS.find(k => k === input.kind) ?? 'question'
      const text = String(input.text ?? '').trim()
      if (!text) return { deny: 'text is required' }
      const now = await $.clock.now()
      const ask: Ask = { id: `${now.toString(36)}${(seq++ % 36).toString(36)}`, kind, text, at: now, ...(input.command ? { command: String(input.command) } : {}) }
      await update($, asks, list => [...list, ask])
      // A plugin tool's result is the text the model reads (string or content blocks).
      return { result: `Queued for the user as ${ask.id}.` }
    } catch (err) {
      return { deny: `needs-you: ${String(err)}` }
    }
  })

  on('tool.call', { tool: RESOLVE_TOOL }, async ($, e) => {
    try {
      const id = String((e as unknown as { id?: string }).id ?? '')
      const had = (await read($, asks)).some(a => a.id === id)
      await remove($, id)
      return { result: had ? `Cleared ${id}.` : `No open ask ${id}.` }
    } catch (err) {
      return { deny: `needs-you: ${String(err)}` }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, asks)
    if (list.length === 0 || e.props.hasSurvey) return next(e)
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const open = await read($, isOpen)
    const now = await $.clock.now()
    const toggle = () => update($, isOpen, v => !v)
    const pill = (
      <Box gap={1}>
        <Text backgroundColor={AMBER} color="#000000" bold> ● {list.length} needed from you </Text>
        <Button key="toggle" plain label={open ? '▾ hide' : '▸ show'} onPress={toggle} />
        {open && <Button key="clear-all" plain dimColor label="clear all" onPress={() => update($, asks, () => [])} />}
      </Box>
    )
    if (!open) return pill

    // Newest first, as many as the band's rows allow.
    let rows = Math.max(1, e.props.maxRows) - 1
    const shown: Ask[] = []
    for (const ask of [...list].reverse()) {
      const need = 4 + (ask.command ? ask.command.split('\n').length : 0)
      if (shown.length > 0 && need > rows) break
      shown.push(ask)
      rows -= need
    }
    return (
      <Box flexDirection="column">
        {pill}
        {shown.map(ask => (
          <Box key={`ask-${ask.id}`} flexDirection="column" borderStyle="round" borderColor={AMBER} paddingX={1}>
            <Box justifyContent="space-between">
              <Text color={AMBER} bold>{LABEL[ask.kind]}</Text>
              <Text dimColor>{ago(ask.at, now)}</Text>
            </Box>
            <Text>{ask.text}</Text>
            {ask.command && <Code source={copyText(ask)} language={ask.kind === 'sql' ? 'sql' : 'bash'} wrap="wrap" />}
            <Box gap={2}>
              {ask.command && <Button key={`copy-${ask.id}`} variant="primary" label="copy" onPress={press => copy($, ask, press.surface)} />}
              <Button key={`done-${ask.id}`} label="done" onPress={() => remove($, ask.id)} />
            </Box>
          </Box>
        ))}
        {shown.length < list.length && <Text dimColor>+{list.length - shown.length} older</Text>}
      </Box>
    )
  })
}
