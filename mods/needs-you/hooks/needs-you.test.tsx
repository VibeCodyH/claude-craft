import { expect, mock, test } from 'claude-code/testing'

import { ago, copyText } from './register'

test('copy text: in-session runs get the ! prefix, SQL does not', async () => {
  expect(copyText({ id: 'a', kind: 'run', text: 't', command: 'gh pr merge 1', at: 0 })).toBe('! gh pr merge 1')
  expect(copyText({ id: 'a', kind: 'run', text: 't', command: '! ls', at: 0 })).toBe('! ls')
  expect(copyText({ id: 'b', kind: 'sql', text: 't', command: 'SELECT 1;', at: 0 })).toBe('SELECT 1;')
  expect(ago(0, 90 * 60000)).toBe('1h30m ago')
})

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 30 } as never } as const

test('an ask shows the pill, opens to a card with copy, and done clears it', async ($, on) => {
  mock.clock(on, { now: 1791480000000 })
  on('tool.register', async ($, e) => ({ value: { tool: `mcp__needs-you__${e.name}` } }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.copy', async () => ({ value: { isCopied: true as const } }))
  on('ui.render', async ($, e) => { const { Box } = $.ui.resolve(e); return <Box /> })
  await $.session.start({ source: 'startup', cwd: '/h', surface: 'terminal', isInteractive: true } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const empty = await $.ui.mount({ plugin: 'needs-you', surface, ...BAND })
    expect(await empty.find({ type: 'Text', text: /needed from you/ })).toBeUndefined()
    await empty.unmount()
  }

  const ran = await $.tool.call({ tool: 'mcp__needs-you__ask', kind: 'sql', text: 'Run the no-evidence count', command: 'SELECT count(*) FROM x;' } as never)
  // The engine requires a plugin tool's result to be text; the id rides in it.
  const result = (ran as { result?: unknown }).result
  expect(typeof result).toBe('string')
  const id = String(result).match(/as (\w+)\./)?.[1]
  expect(id).toBeDefined()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'needs-you', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /1 needed from you/ })).toBeDefined()
    expect(await ui.find({ key: `copy-${id}` })).toBeUndefined()
    await ui.press({ key: 'toggle' })
    expect(await ui.find({ key: `copy-${id}` })).toBeDefined()
    await ui.press({ key: `copy-${id}` })
    await ui.press({ key: 'toggle' })
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'needs-you', surface: 'terminal', ...BAND })
  await ui.press({ key: 'toggle' })
  await ui.press({ key: `done-${id}` })
  expect(await ui.find({ type: 'Text', text: /needed from you/ })).toBeUndefined()
  await ui.unmount()

  await $.tool.call({ tool: 'mcp__needs-you__ask', kind: 'question', text: 'Warn or refuse?' } as never)
  const again = await $.ui.mount({ plugin: 'needs-you', surface: 'terminal', ...BAND })
  expect(await again.find({ type: 'Text', text: /1 needed from you/ })).toBeDefined()
  await again.unmount()
})
