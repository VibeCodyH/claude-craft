export type Held = {
  command: string
  label: string
  dir: string
  summary: string
  lines: string[]
  more: number
  where: 'pane' | 'band'
}

declare module 'claude-code' {
  interface PluginState {
    'blast-radius': { held: Held | null }
  }
}
