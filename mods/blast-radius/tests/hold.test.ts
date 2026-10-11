import { describe, expect, test } from 'claude-code/testing'

const PANE = { surface: 'terminal', component: 'Pane', requestId: 'blast-radius', props: {} } as const

type Ui = { find: (q: never) => Promise<unknown> }

// Stubs for what the engine would answer. The stubbed `tool.call` beneath the
// plugin stands for Claude Code's approval dialog and the run: it records what
// the pane showed while the call sat there, then answers as an approved run.
function stubs(on: unknown, ui: () => Ui | null, seen: string[]) {
  const o = on as (event: string, ...rest: any[]) => void
  o('session.cwd', () => ({ value: '/work' }))
  o('ui.open', () => ({ value: { isPlaced: true } }))
  o('ui.close', () => ({ value: undefined }))
  o('tool.call', async () => {
    const u = ui()
    if (u) {
      if (await u.find({ type: 'Text', text: /delete 2 files \(1\.1 MB\)/ } as never)) seen.push('summary')
      if (await u.find({ type: 'Text', text: /build\/index\.html/ } as never)) seen.push('file')
      if (await u.find({ type: 'Text', text: /Approve or reject it in the Claude Code prompt/ } as never)) seen.push('hint')
    }
    return { result: { stdout: 'ran', stderr: '', interrupted: false } }
  })
  o('ui.render', { component: 'Pane' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: 'EMPTY' })
  })
  o('process.run', async ($: unknown, e: { argv: string[] }) => {
    const [cmd] = e.argv
    const stdout = cmd === 'find' ? '/work/build/index.html\n/work/build/app.js\n' : cmd === 'du' ? '1100\t/work/build\n' : cmd === 'printenv' ? '/home/me\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

describe('the report', () => {
  test('shows beside the built-in approval, never decides the call, and clears after', async ($, on) => {
    let ui: Ui | null = null
    const seen: string[] = []
    stubs(on, () => ui, seen)
    ui = (await $.ui.mount({ plugin: 'blast-radius', ...PANE } as never)) as unknown as Ui

    const result = (await $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as never)) as {
      deny?: string
      result?: { stdout: string }
    }
    expect(seen).toEqual(['summary', 'file', 'hint'])
    expect(result.deny).toBeUndefined()
    expect(result.result?.stdout).toBe('ran')
    expect(await ui.find({ type: 'Text', text: /^EMPTY$/ } as never)).toBeDefined()
  })

  test('a safe command passes straight through with nothing shown', async ($, on) => {
    let ui: Ui | null = null
    const seen: string[] = []
    stubs(on, () => ui, seen)
    ui = (await $.ui.mount({ plugin: 'blast-radius', ...PANE } as never)) as unknown as Ui
    await $.tool.call({ tool: 'Bash', command: 'ls build' } as never)
    expect(seen).toEqual([])
  })
})
