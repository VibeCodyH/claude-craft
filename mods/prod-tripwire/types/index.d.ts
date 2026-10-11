export type ProdTouch = { label: string; command: string; at: number; failed?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'prod-tripwire': { running: ProdTouch | null; last: ProdTouch | null }
  }
}
