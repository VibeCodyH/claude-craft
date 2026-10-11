export type Handoff = { text: string; lines: number; at: number }

declare module 'claude-code' {
  interface PluginState {
    'clipboard-step': { handoff: Handoff | null }
  }
}
