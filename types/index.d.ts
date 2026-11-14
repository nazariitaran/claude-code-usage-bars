export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Context = { tokens?: number; window: number; percent?: number }
export type AgentContext = { tokens: number; model: string }
export type Band = { agentId: string | null; columns: number }
// `usedAtStart` is the weekly percent when day `day` (0–6) of the window began.
export type Pace = { resetsAt: string; day: number; usedAtStart: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-bars': {
      limits: Limit[]
      context: Context | null
      agentContexts: Record<string, AgentContext>
      mainModel: string | null
      band: Band | null
      pace: Pace | null
    }
  }
}
