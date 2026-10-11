import { describe, expect, test } from 'claude-code/testing'

import { detect, isRefresh, summarize } from '../hooks/pr'
import type { Raw } from '../hooks/pr'

const HEAD = '2a99a009aaaabbbbccccddddeeeeffff00001111'

function raw(over: Partial<Raw> = {}): Raw {
  return {
    title: '#2571 Rollout guides print page',
    state: 'OPEN',
    isDraft: false,
    head: HEAD,
    merge: 'BLOCKED',
    requested: ['teammate'],
    checks: [
      { name: 'typecheck', conclusion: 'SUCCESS' },
      { name: 'Vercel', conclusion: 'SUCCESS' },
      { name: 'unit', conclusion: '' },
    ],
    last: null,
    ...over,
  }
}

describe('detect', () => {
  test('babysit watcher, a new PR, and a re-request track; plain reads do not', () => {
    expect(detect('bash ~/.claude/skills/babysit/scripts/watch-review.sh acme/widgets 42 3 120', ''))
      .toEqual([{ repo: 'acme/widgets', number: 42 }])
    expect(detect('gh pr create -R acme/widgets --head me/x --base main', 'https://github.com/Acme/Widgets/pull/43\n'))
      .toEqual([{ repo: 'Acme/Widgets', number: 43 }])
    expect(detect('gh pr edit 42 -R acme/widgets --add-reviewer review-bot', ''))
      .toEqual([{ repo: 'acme/widgets', number: 42 }])
    expect(detect('gh pr edit -R acme/widgets 42 --add-reviewer review-bot', ''))
      .toEqual([{ repo: 'acme/widgets', number: 42 }])
    expect(detect('gh pr edit https://github.com/a/b/pull/9 --add-reviewer x', ''))
      .toEqual([{ repo: 'a/b', number: 9 }])
    // a re-request with no repo is skipped rather than guessed
    expect(detect('gh pr edit 42 --add-reviewer review-bot', '')).toEqual([])
    expect(detect('gh pr edit 42 -R a/b --title x', '')).toEqual([])
    expect(detect('gh pr view 42 -R acme/widgets', 'https://github.com/a/b/pull/1')).toEqual([])
    expect(detect('gh pr review 42 -R acme/widgets --approve', '')).toEqual([])
  })

  test('pushes, merges and comments refresh; reads do not', () => {
    expect(isRefresh('git -C /wt push origin me/x')).toBe(true)
    expect(isRefresh('gh pr comment 1 -R a/b --body-file f')).toBe(true)
    expect(isRefresh('gh pr merge 1 -R a/b --squash --auto')).toBe(true)
    expect(isRefresh('git status && gh pr view 1')).toBe(false)
  })
})

describe('summarize', () => {
  test('a pending review check reads as the bot reviewing', () => {
    const s = summarize(raw({ checks: [{ name: 'cadre-review', conclusion: '' }, { name: 'gate', conclusion: 'SUCCESS' }] }))
    expect(s.verdict).toEqual({ label: 'bot reviewing', tone: 'wait' })
    expect(s.checks).toEqual({ pass: 1, fail: 0, pending: 1, failing: [] })
  })

  test('a pending Vercel Preview check is not the bot reviewing', () => {
    const s = summarize(raw({
      checks: [{ name: 'Vercel Preview Comments', conclusion: '' }],
      last: { by: 'review-bot', state: 'DISMISSED', commit: 'old' },
    }))
    expect(s.verdict?.label).toBe('new commits, re-request review-bot')
  })

  test('an approval counts only on the commit it reviewed', () => {
    const on = summarize(raw({ last: { by: 'review-bot', state: 'APPROVED', commit: HEAD } }))
    expect(on.verdict).toEqual({ label: 'approved by review-bot', tone: 'good' })

    const stale = summarize(raw({ last: { by: 'review-bot', state: 'DISMISSED', commit: 'old' } }))
    expect(stale.verdict?.label).toBe('new commits, re-request review-bot')

    const asked = summarize(raw({ requested: ['teammate', 'review-bot'], last: { by: 'review-bot', state: 'DISMISSED', commit: 'old' } }))
    expect(asked.verdict?.label).toBe('awaiting review-bot')
  })

  test('changes requested, failing checks, merge state, merged', () => {
    const s = summarize(raw({
      merge: 'DIRTY',
      last: { by: 'review-bot', state: 'CHANGES_REQUESTED', commit: HEAD },
      checks: [{ name: 'integration', conclusion: 'FAILURE' }, { name: 'Vercel', conclusion: 'SUCCESS' }],
    }))
    expect(s.verdict?.tone).toBe('bad')
    expect(s.checks).toEqual({ pass: 1, fail: 1, pending: 0, failing: ['integration'] })
    expect(s.merge).toBe('conflicts')
    expect(summarize(raw({ merge: 'BEHIND' })).merge).toBe('behind')
    expect(summarize(raw({ state: 'MERGED' })).verdict).toEqual({ label: 'merged', tone: 'done' })
  })
})

const BAND = {
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160 },
} as const

describe('the band', () => {
  test('babysit starts: the PR shows above whatever else draws there', async ($, on) => {
    const ghCalls: string[][] = []
    const o = on as (event: string, ...rest: any[]) => void
    o('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
    o('process.run', ($: unknown, e: { argv: string[] }) => {
      ghCalls.push(e.argv)
      const out = raw({ checks: [{ name: 'cadre-review', conclusion: '' }], merge: 'BEHIND' })
      return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    o('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
      const { Text } = $.ui.resolve(e)
      return Text({ children: 'ENGINE' })
    })

    const ui = await $.ui.mount({ plugin: 'pr-tracker', ...BAND } as never)
    await $.tool.call({ tool: 'Bash', command: 'git status' } as never)
    expect(await ui.find({ type: 'Text', text: /bot reviewing/ } as never)).toBeUndefined()
    expect(ghCalls).toEqual([])

    await $.tool.call({
      tool: 'Bash',
      command: 'bash ~/.claude/skills/babysit/scripts/watch-review.sh acme/widgets 42 3 120',
    } as never)
    expect(ghCalls[0]?.slice(0, 5)).toEqual(['gh', 'pr', 'view', '42', '-R'])
    expect(await ui.find({ type: 'Text', text: /bot reviewing/ } as never)).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /behind/ } as never)).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ENGINE$/ } as never)).toBeDefined()
    await ui.unmount()
  })
})
