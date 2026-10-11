export type Window = { left: number; resetsAt: number }

export type Snapshot = {
  at: number
  next: string | null
  clock: string | null
  codex: { fiveHour: Window | null; weekly: Window | null }
  claude: { fiveHour: Window | null; weekly: Window | null }
  contextLeft: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { snap: Snapshot | null }
  }
}
