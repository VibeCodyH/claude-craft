import { describe, expect, mock, test } from 'claude-code/testing'

import { claudeWindows, countdown, parseCodex, parseNext } from '../hooks/register'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 160,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

describe('usage-band', () => {
  test('countdown formats', async () => {
    expect(countdown(0, 1000)).toBe('ready')
    expect(countdown(90 * 60_000, 0)).toBe('1h30m')
    expect(countdown(51 * 3_600_000, 0)).toBe('2d3h')
    expect(countdown(10_000, 0)).toBe('1m')
  })

  test('codex log parsed by window size', async () => {
    const row = (p: unknown) =>
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: p } })
    const text = [
      row({ primary: { used_percent: 90, window_minutes: 300, resets_at: 100 } }),
      '{"type":"event_msg","payload":{"type":"agent_message"}}',
      row({
        primary: { used_percent: 28, window_minutes: 300, resets_at: 200 },
        secondary: { used_percent: 61.4, window_minutes: 10080, resets_at: 300 },
      }),
      '',
    ].join('\n')
    expect(parseCodex(text)).toEqual({
      fiveHour: { left: 72, resetsAt: 200_000 },
      weekly: { left: 39, resetsAt: 300_000 },
    })
    expect(parseCodex('garbage\n')).toEqual({ fiveHour: null, weekly: null })
  })

  test('next event file', async () => {
    expect(parseNext('{"next_date":"10/12","next_text":"Standup"}')).toBe('10/12  Standup')
    expect(parseNext('{"next_text":"Standup"}')).toBe('Standup')
    expect(parseNext('{"next_date":"10/12"}')).toBeNull()
    expect(parseNext('not json')).toBeNull()
  })

  test('claude windows', async () => {
    const w = claudeWindows([
      { kind: 'five_hour', percentUsed: 23.5, resetsAt: '1970-01-01T00:00:10Z' },
      { kind: 'seven_day', percentUsed: 70 },
    ])
    expect(w).toEqual({ fiveHour: { left: 77, resetsAt: 10_000 }, weekly: { left: 30, resetsAt: 0 } })
  })

  test('band draws on desktop and terminal', async ($, on) => {
    mock.clock(on)
    mock.env(on, { HOME: '/nonexistent' })
    on('session.usage', () => ({
      value: {
        startedAt: 0,
        context: { window: 200_000, tokens: 68_000, percent: 34 },
        rateLimits: [
          { kind: 'five_hour', percentUsed: 92, resetsAt: '2099-01-01T00:00:00Z' },
          { kind: 'seven_day', percentUsed: 45, resetsAt: '2099-01-01T00:00:00Z' },
        ],
      },
    }))
    on('process.run', (_$, e) =>
      e.argv[0] === 'date'
        ? { value: { exitCode: 0, stdout: 'Sun Oct 11  3:42 PM\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
        : { deny: 'no other processes in tests' },
    )
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    await $.session.measure({
      context: { window: 200_000, tokens: 68_000, percent: 34 },
      rateLimits: [],
      changed: ['context'],
    })
    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await $.ui.mount({ plugin: 'usage-band', surface, ...BAND })
      expect(await ui.find({ type: 'Text', text: /^8%$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^55%$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /66% left/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /NEXT/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^Sun Oct 11  3:42 PM$/ })).toBeDefined()
      await ui.unmount()
    }
  })
})
