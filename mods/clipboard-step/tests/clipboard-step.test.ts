import { describe, expect, test } from 'claude-code/testing'

const BAND = {
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 140 },
} as const

describe('clipboard-step', () => {
  test('shows what is actually on the clipboard after a wl-copy, until the next prompt', async ($, on) => {
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
    on('process.run', () => ({ value: { exitCode: 0, stdout: '! gh pr merge 2487 --squash', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
    on('prompt.submit', ($, e) => ({ text: e.text }) as never)
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return Text({ children: 'ENGINE' })
    })

    const ui = await $.ui.mount({ plugin: 'clipboard-step', ...BAND } as never)
    await $.tool.call({ tool: 'Bash', command: "printf '%s' 'x' | wl-copy" } as never)
    expect(await ui.find({ type: 'Text', text: /On your clipboard/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /gh pr merge 2487/ })).toBeDefined()

    await $.prompt.submit({ text: 'done' } as never)
    expect(await ui.find({ type: 'Text', text: /^ENGINE$/ })).toBeDefined()
    await ui.unmount()
  })

  test('a command that does not touch the clipboard shows nothing', async ($, on) => {
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return Text({ children: 'ENGINE' })
    })
    const ui = await $.ui.mount({ plugin: 'clipboard-step', ...BAND } as never)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    expect(await ui.find({ type: 'Text', text: /On your clipboard/ })).toBeUndefined()
    await ui.unmount()
  })

  // A `!` run never fires prompt.submit, so the band outlived the step and the
  // same command read as a new one (a person ran one three times).
  test('pasting the staged command into the prompt takes the band down, with or without the !', async ($, on) => {
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
    on('process.run', () => ({ value: { exitCode: 0, stdout: '! gh pr edit 42 -R acme/widgets --add-reviewer review-bot', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
    on('prompt.edit', ($, e) => ({ text: e.text, cursor: e.cursor }) as never)
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return Text({ children: 'ENGINE' })
    })
    const ui = await $.ui.mount({ plugin: 'clipboard-step', ...BAND } as never)
    const edit = (inputText: string) =>
      $.prompt.edit({ origin: 'person', text: '', cursor: 0, start: 0, end: 0, inputText } as never)

    await $.tool.call({ tool: 'Bash', command: "printf '%s' 'x' | wl-copy" } as never)
    await edit('hello')
    expect(await ui.find({ type: 'Text', text: /On your clipboard/ })).toBeDefined()
    await edit('gh pr edit 42 -R acme/widgets --add-reviewer review-bot')
    expect(await ui.find({ type: 'Text', text: /^ENGINE$/ })).toBeDefined()

    await $.tool.call({ tool: 'Bash', command: "printf '%s' 'x' | wl-copy" } as never)
    await edit('! gh pr edit 42 -R acme/widgets --add-reviewer review-bot')
    expect(await ui.find({ type: 'Text', text: /^ENGINE$/ })).toBeDefined()
    await ui.unmount()
  })

  test('clearing the clipboard takes the band down', async ($, on) => {
    let clip = '! gh pr merge 2487 --squash'
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)
    on('process.run', () => ({ value: { exitCode: 0, stdout: clip, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return Text({ children: 'ENGINE' })
    })
    const ui = await $.ui.mount({ plugin: 'clipboard-step', ...BAND } as never)
    await $.tool.call({ tool: 'Bash', command: "printf '%s' 'x' | wl-copy" } as never)
    expect(await ui.find({ type: 'Text', text: /On your clipboard/ })).toBeDefined()
    clip = ''
    await $.tool.call({ tool: 'Bash', command: 'wl-copy --clear' } as never)
    expect(await ui.find({ type: 'Text', text: /^ENGINE$/ })).toBeDefined()
    await ui.unmount()
  })
})
