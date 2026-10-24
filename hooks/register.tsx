import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, Timer } from 'claude-code'

import type { AgentContext, Context, Limit } from '../types'

const limits = atom({ plugin: 'usage-bars', key: 'limits' } as const, [] as Limit[])
const context = atom({ plugin: 'usage-bars', key: 'context' } as const, null as Context | null)
const agentContexts = atom(
  { plugin: 'usage-bars', key: 'agentContexts' } as const,
  {} as Record<string, AgentContext>,
)
const mainModel = atom({ plugin: 'usage-bars', key: 'mainModel' } as const, null as string | null)
const viewedAgent = atom(
  { plugin: 'usage-bars', key: 'viewedAgent' } as const,
  null as string | null,
)

const LABELS: Record<string, string> = {
  five_hour: 'Session',
  seven_day: 'Weekly',
  spend_limit: 'Spend',
}
const ORDER = ['five_hour', 'seven_day', 'spend_limit']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// The engine draws the hint line inset from both terminal edges.
const LINE_INSET = 4
const COLUMN_GAP = 3
const MIN_BAR = 8
// A seven-eighths block leaves a sliver between stacked bars; a full block doesn't.
const BAR = '▇'
const LABEL_WIDTH = 7
// "Sun 00:20", "142k/200k"
const EXTRA_WIDTH = 9
// The engine reports a window size for the main conversation only; a subagent
// on another model is assumed to have the standard one.
const DEFAULT_WINDOW = 200_000

type Cell = { key: string; label: string; percent: number; extra: string }

const pad2 = (n: number) => String(n).padStart(2, '0')

function formatReset(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const at = new Date(iso)
  if (at.getTime() <= now) return 'reset'
  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`
  const isToday = new Date(now).toDateString() === at.toDateString()
  return `${isToday ? '' : `${WEEKDAYS[at.getDay()]} `}${time}`
}

function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`
}

function barColor(percent: number) {
  if (percent >= 90) return 'error'
  if (percent >= 70) return 'warning'
  return 'success'
}

function contextCell(tokens: number | undefined, window: number, percent?: number): Cell | null {
  if (tokens === undefined) return null
  return {
    key: 'context',
    label: 'Context',
    percent: percent ?? Math.round((tokens / window) * 100),
    extra: `${formatTokens(tokens)}/${formatTokens(window)}`,
  }
}

let resetTimer: Timer | undefined

// The engine only learns of a reset from the next API response, so zero a
// window ourselves once its reset time passes.
async function store($: EngineInterface, next: Limit[]) {
  await update($, limits, () => next)
  resetTimer?.cancel()
  const now = await $.clock.now()
  const upcoming = next
    .map(l => (l.resetsAt ? Date.parse(l.resetsAt) : NaN))
    .filter(t => t > now)
  if (upcoming.length === 0) return
  resetTimer = $.clock.after(Math.min(...upcoming) - now + 1000, async () => {
    const at = await $.clock.now()
    const current = await read($, limits)
    await store(
      $,
      current.map(l =>
        l.resetsAt && Date.parse(l.resetsAt) <= at ? { ...l, percentUsed: 0 } : l,
      ),
    )
  })
}

async function storeContext($: EngineInterface, c: SessionContextUsage) {
  const { tokens, window, percent } = c
  await update($, context, () => ({ tokens, window, percent }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    if (usage.rateLimits.length > 0) await store($, usage.rateLimits)
    await storeContext($, usage.context)
    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await store($, e.rateLimits)
    if (e.changed.includes('context')) await storeContext($, e.context)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (!usage) return result
    if (e.agentId === undefined) {
      await update($, mainModel, () => usage.model)
      return result
    }
    const tokens =
      usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
    const agentId = e.agentId
    await update($, agentContexts, all => ({
      ...all,
      [agentId]: { tokens, model: usage.model },
    }))
    return result
  })

  // Only the band above the prompt is told which transcript is in view, so it
  // relays the switch to the hint line. A render may not write state itself.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const agentId = e.props.view.agentId ?? null
    if (agentId !== (await read($, viewedAgent))) {
      $.clock.after(0, () => void update($, viewedAgent, () => agentId))
    }
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const line = await next(e)
    const now = await $.clock.now()

    const right: Cell[] = [...(await read($, limits))]
      .sort((a, b) => rank(a.kind) - rank(b.kind))
      .map(l => ({
        key: l.kind,
        label: LABELS[l.kind] ?? l.kind,
        percent: Math.round(l.percentUsed),
        extra: formatReset(l.resetsAt, now),
      }))

    const main = await read($, context)
    const agentId = await read($, viewedAgent)
    let ctx: Cell | null
    if (agentId === null) {
      ctx = main ? contextCell(main.tokens, main.window, main.percent) : null
    } else {
      const agent = (await read($, agentContexts))[agentId]
      const window =
        main && agent?.model === (await read($, mainModel)) ? main.window : DEFAULT_WINDOW
      ctx = contextCell(agent?.tokens, window)
    }
    const left = ctx ? [ctx] : []
    if (left.length === 0 && right.length === 0) return line

    const { Box, Text } = $.ui.resolve(e)
    const cellWidth = Math.floor(((e.viewport?.columns ?? 80) - LINE_INSET - COLUMN_GAP) / 2)
    // "label ", bar, " 100%", "  extra": every part but the bar is fixed-width
    // so the bar only changes with the terminal.
    const barWidth = Math.max(MIN_BAR, cellWidth - (LABEL_WIDTH + 1) - 5 - (2 + EXTRA_WIDTH))

    const cell = (c: Cell | undefined) => {
      if (!c) return null
      const filled = Math.round((Math.min(c.percent, 100) / 100) * barWidth)
      return (
        <Box key={c.key}>
          <Text dimColor>{c.label.padEnd(LABEL_WIDTH)} </Text>
          <Text color={barColor(c.percent)}>{BAR.repeat(filled)}</Text>
          <Text dimColor>{BAR.repeat(barWidth - filled)}</Text>
          <Text>{` ${String(c.percent).padStart(3)}%`}</Text>
          <Text dimColor>{`  ${c.extra.padEnd(EXTRA_WIDTH)}`}</Text>
        </Box>
      )
    }

    const rows = Math.max(left.length, right.length)
    return (
      <Box flexDirection="column">
        {line}
        {Array.from({ length: rows }, (_, i) => (
          <Box key={`row-${i}`}>
            <Box width={cellWidth} flexShrink={0}>
              {cell(left[i])}
            </Box>
            <Box marginLeft={COLUMN_GAP} flexShrink={0}>
              {cell(right[i])}
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}

function rank(kind: string) {
  const i = ORDER.indexOf(kind)
  return i === -1 ? ORDER.length : i
}
