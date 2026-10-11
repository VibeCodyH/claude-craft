export type Tone = 'good' | 'bad' | 'wait' | 'dim' | 'done'

export type Checks = { pass: number; fail: number; pending: number; failing: string[] }

export type Pr = {
  repo: string
  number: number
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED' | null
  verdict: { label: string; tone: Tone } | null
  checks: Checks | null
  merge: 'behind' | 'conflicts' | null
  head: string
  error: string | null
  endedAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'pr-tracker': { prs: Pr[] }
  }
}
