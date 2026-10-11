export type AskKind = 'question' | 'run' | 'sql' | 'shell'

export type Ask = {
  id: string
  kind: AskKind
  text: string
  command?: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'needs-you': { asks: Ask[]; isOpen: boolean }
  }
}
