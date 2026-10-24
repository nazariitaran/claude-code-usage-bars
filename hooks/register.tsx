import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, Timer } from 'claude-code'

import type { AgentContext, Band, Context, Limit } from '../types'

const limits = atom({ plugin: 'usage-bars', key: 'limits' } as const, [] as Limit[])
const context = atom({ plugin: 'usage-bars', key: 'context' } as const, null as Context | null)
const agentContexts = atom(
  { plugin: 'usage-bars', key: 'agentContexts' } as const,
  {} as Record<string, AgentContext>,
)
const mainModel = atom({ plugin: 'usage-bars', key: 'mainModel' } as const, null as string | null)
const band = atom({ plugin: 'usage-bars', key: 'band' } as const, null as Band | null)

const LABELS: Record<string, string> = {
  five_hour: 'Session',
  seven_day: 'Weekly',
  spend_limit: 'Spend',
}
const ORDER = ['five_hour', 'seven_day', 'spend_limit']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// The band reports its column less a five-cell mark of its own.
const BAND_MARK = 5
// The engine draws the hint line inset from both edges of that column.
const LINE_INSET = 4
const COLUMN_GAP = 3
const MIN_BAR = 8
// A seven-eighths block leaves a sliver between stacked bars; a full block doesn't.
const BAR = '▇'
const LABEL_WIDTH = 7
// "Sun 00:20", "142k/200k"
const EXTRA_WIDTH = 9
const PERCENT_WIDTH = 5
const FIXED_WIDTH = LABEL_WIDTH + 1 + PERCENT_WIDTH + 2 + EXTRA_WIDTH
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
  return n >= 999_500 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`
}

function barColor(percent: number) {
  if (percent >= 90) return 'error'
  if (percent >= 70) return 'warning'
  return 'success'
}

const inputTokens = (u: ModelUsage) =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

function contextCell(tokens: number, window: number, percent?: number): Cell {
  return {
    key: 'context',
    label: 'Context',
    percent: percent ?? Math.round((tokens / window) * 100),
    extra: `${formatTokens(tokens)}/${formatTokens(window)}`,
  }
}

// The engine only learns of a reset from the next API response, so a window
// whose reset time has passed is shown as empty until then.
function zeroPassed(list: Limit[], now: number): Limit[] {
  return list.map(l =>
    l.resetsAt && Date.parse(l.resetsAt) <= now ? { ...l, percentUsed: 0 } : l,
  )
}

let resetTimer: Timer | undefined

function scheduleReset($: EngineInterface, list: Limit[], now: number) {
  resetTimer?.cancel()
  resetTimer = undefined
  const upcoming = list
    .map(l => (l.resetsAt ? Date.parse(l.resetsAt) : NaN))
    .filter(t => t > now)
  if (upcoming.length === 0) return
  resetTimer = $.clock.after(Math.min(...upcoming) - now + 1000, async () => {
    const at = await $.clock.now()
    const current = await update($, limits, cur => zeroPassed(cur, at))
    scheduleReset($, current, at)
  })
}

async function storeLimits($: EngineInterface, next: Limit[]) {
  const now = await $.clock.now()
  const stored = zeroPassed(next, now)
  await update($, limits, () => stored)
  scheduleReset($, stored, now)
}

let relaySeq = 0

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    await storeLimits($, usage.rateLimits)
    const { tokens, window, percent } = usage.context
    await update($, context, () => ({ tokens, window, percent }))
    return result
  })

  on('session.measure', async ($, e, next) => {
    // Stored every time: a new reset time with under a point of movement is
    // not reported in `changed`.
    await storeLimits($, e.rateLimits)
    const { tokens, window, percent } = e.context
    await update($, context, () => ({ tokens, window, percent }))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage
    if (!usage) return result
    const tokens = inputTokens(usage)
    const agentId = e.agentId
    if (agentId === undefined) {
      // session.measure only fires once the whole turn ends; this keeps the
      // main bar moving during a long turn.
      await update($, mainModel, () => usage.model)
      await update($, context, cur =>
        cur ? { tokens, window: cur.window, percent: Math.round((tokens / cur.window) * 100) } : cur,
      )
      return result
    }
    await update($, agentContexts, all => ({
      ...all,
      [agentId]: { tokens, model: usage.model },
    }))
    return result
  })

  // Only the band above the prompt is told which transcript is in view and how
  // wide its column is, so it relays both to the hint line. A render may not
  // write state, hence the timer; the sequence drops relays a newer one overtook.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const seen: Band = {
      agentId: e.props.view.agentId ?? null,
      columns: e.props.bodyColumns + BAND_MARK,
    }
    const stored = await read($, band)
    if (stored?.agentId !== seen.agentId || stored.columns !== seen.columns) {
      const seq = ++relaySeq
      $.clock.after(0, () => {
        if (seq === relaySeq) void update($, band, () => seen)
      })
    }
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const line = await next(e)
    const relayed = await read($, band)
    const columns = relayed?.columns ?? e.viewport?.columns
    if (columns === undefined) return line
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
    const agentId = relayed?.agentId ?? null
    let ctx: Cell | null = null
    if (agentId === null) {
      if (main?.tokens !== undefined) ctx = contextCell(main.tokens, main.window, main.percent)
    } else {
      const agent = (await read($, agentContexts))[agentId]
      const sameModel = agent !== undefined && agent.model === (await read($, mainModel))
      const window = main && sameModel ? main.window : DEFAULT_WINDOW
      ctx = contextCell(agent?.tokens ?? 0, window)
    }
    const left = ctx ? [ctx] : []
    if (left.length === 0 && right.length === 0) return line

    const { Box, Text } = $.ui.resolve(e)
    const room = columns - LINE_INSET
    const halfWidth = Math.floor((room - COLUMN_GAP) / 2)
    const isTwoColumn = halfWidth >= FIXED_WIDTH + MIN_BAR
    const cellWidth = isTwoColumn ? halfWidth : room
    // Every part but the bar is fixed-width so the bar only changes with the
    // column; on a very narrow one the reset/token column goes first.
    const showExtra = cellWidth >= FIXED_WIDTH + MIN_BAR
    const fixed = showExtra ? FIXED_WIDTH : FIXED_WIDTH - 2 - EXTRA_WIDTH
    const barWidth = Math.max(1, cellWidth - fixed)

    const cell = (c: Cell | undefined) => {
      if (!c) return null
      const filled = Math.round((Math.min(c.percent, 100) / 100) * barWidth)
      return (
        <Box key={c.key}>
          <Text dimColor>{c.label.padEnd(LABEL_WIDTH)} </Text>
          <Text color={barColor(c.percent)}>{BAR.repeat(filled)}</Text>
          <Text dimColor>{BAR.repeat(barWidth - filled)}</Text>
          <Text>{` ${String(c.percent).padStart(3)}%`}</Text>
          {showExtra ? <Text dimColor>{`  ${c.extra.padEnd(EXTRA_WIDTH)}`}</Text> : null}
        </Box>
      )
    }

    if (!isTwoColumn) {
      return (
        <Box flexDirection="column">
          {line}
          {[...left, ...right].map(cell)}
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
