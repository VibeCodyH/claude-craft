import { describe, expect, test } from 'claude-code/testing'

import { classify, parsePatterns } from '../hooks/register'

const BAND = {
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 },
} as const

describe('prod-tripwire', () => {
  test('a prod command shows the red band while it runs, then the dim note until the next prompt', async ($, on) => {
    let release: () => void = () => {}
    const gate = new Promise<void>(r => (release = r))
    on('tool.call', async () => {
      await gate
      return { result: { stdout: 'ok', stderr: '', interrupted: false } } as never
    })
    on('prompt.submit', ($, e) => ({ text: e.text }) as never)
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return Text({ children: 'ENGINE' })
    })

    const ui = await $.ui.mount({ plugin: 'prod-tripwire', ...BAND } as never)
    expect(await ui.find({ type: 'Text', text: /^ENGINE$/ })).toBeDefined()

    const call = $.tool.call({ tool: 'Bash', command: 'npm run db:migrate:prod' } as never)
    await new Promise(r => setTimeout(r, 20))
    expect(await ui.find({ type: 'Text', text: /PROD/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /prod MIGRATION/ })).toBeDefined()

    release()
    await call
    expect(await ui.find({ type: 'Text', text: /last PROD touch at .*prod MIGRATION/ })).toBeDefined()

    await $.prompt.submit({ text: 'next' } as never)
    expect(await ui.find({ type: 'Text', text: /^ENGINE$/ })).toBeDefined()
    await ui.unmount()
  })

  test('an ordinary command leaves the band alone', async ($, on) => {
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return Text({ children: 'ENGINE' })
    })
    const ui = await $.ui.mount({ plugin: 'prod-tripwire', ...BAND } as never)
    await $.tool.call({ tool: 'Bash', command: 'git status' } as never)
    expect(await ui.find({ type: 'Text', text: /PROD/ })).toBeUndefined()
    await ui.unmount()
  })

  test('your own patterns come first; a broken one is skipped', () => {
    const mine = [...parsePatterns('prod DB=psql .*prod-db;;bad=([;;empty=;;site=example\\.com'), ...parsePatterns('')]
    expect(mine.map(([, label]) => label)).toEqual(['prod DB', 'site'])
    expect(classify('psql -h prod-db.internal', mine)).toBe('prod DB')
    expect(classify('curl https://example.com/api', mine)).toBe('site')
    expect(classify('gh pr merge 42 --squash')).toBe('PR merge')
    expect(classify('git status')).toBeNull()
  })
})
