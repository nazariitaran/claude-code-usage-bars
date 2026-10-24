export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Context = { tokens?: number; window: number; percent?: number }
export type AgentContext = { tokens: number; model: string }

declare module 'claude-code' {
  interface PluginState {
    'usage-bars': {
      limits: Limit[]
      context: Context | null
      agentContexts: Record<string, AgentContext>
      mainModel: string | null
      viewedAgent: string | null
    }
  }
}
