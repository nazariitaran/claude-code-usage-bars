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
const LAYOUT_COLUMNS: Record<string, number> = {
  'one-column': 1,
  'two-columns': 2,
  'three-columns': 3,
}
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
const PERCENT_WIDTH = 4
const LIMITS_KEY = 'lastLimits'
const FIXED_WIDTH = LABEL_WIDTH + 1 + PERCENT_WIDTH + 1 + EXTRA_WIDTH
// The engine reports a window size for the main conversation only, so a
// subagent on another model is measured against what its model id implies.
const WINDOW_SIZE_200k = 200_000
const WINDOW_SIZE_1M = 1_000_000
// First version of each family with the 1M window, from the models overview.
const WINDOW_SIZE_1M_FROM: Record<string, number> = {
  fable: 5,
  mythos: 5,
  opus: 4.6,
  sonnet: 4.6,
  haiku: 5,
}
// Dated ids ("claude-sonnet-4-20250514") have no minor version.
const MODEL_ID = /^claude-(\w+?)-(\d+)(?:-(\d{1,2})(?!\d))?/

function modelWindow(model: string | undefined): number {
  const match = model === undefined ? null : MODEL_ID.exec(model)
  if (!match) return WINDOW_SIZE_200k
  const [, family, major, minor] = match
  const from = WINDOW_SIZE_1M_FROM[family]
  const version = Number(major) + Number(minor ?? 0) / 10
  return from !== undefined && version >= from ? WINDOW_SIZE_1M : WINDOW_SIZE_200k
}

// `percent` is null while there is nothing to measure yet.
type Cell = { key: string; label: string; percent: number | null; extra: string }

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

function agentWindow(
  model: string | undefined,
  tokens: number,
  main: Context | null,
  mainModel: string | null,
): number {
  const window =
    main && model !== undefined && model === mainModel ? main.window : modelWindow(model)
  return tokens > window ? WINDOW_SIZE_1M : window
}

function contextCell(tokens: number | undefined, window: number, percent?: number): Cell {
  if (tokens === undefined) {
    return { key: 'context', label: 'Context', percent: null, extra: `–/${formatTokens(window)}` }
  }
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

// An empty reading means the engine has none yet, not that the limits went
// away, so the last figures stay up.
async function storeLimits($: EngineInterface, next: Limit[]) {
  if (next.length === 0) return
  const now = await $.clock.now()
  const stored = zeroPassed(next, now)
  await update($, limits, () => stored)
  scheduleReset($, stored, now)
}

// Limits are the account's, not the conversation's, so the last reading is
// kept across sessions: a /clear or resume starts with no reading of its own.
async function lastKnownLimits($: EngineInterface): Promise<Limit[]> {
  const saved = await $.store.get(LIMITS_KEY)
  return Array.isArray(saved) ? (saved as Limit[]) : []
}

async function hydrate($: EngineInterface) {
  const usage = await $.session.usage()
  if (usage.rateLimits.length > 0) {
    await storeLimits($, usage.rateLimits)
    await $.store.set(LIMITS_KEY, usage.rateLimits)
  } else {
    await storeLimits($, await lastKnownLimits($))
  }
  const { tokens, window, percent } = usage.context
  await update($, context, () => ({ tokens, window, percent }))
}

let relaySeq = 0
let isHydrating = false

export const register: Register = (on, options) => {
  const maxColumns = LAYOUT_COLUMNS[String(options.layout)] ?? 2
  const showContext = options.showContext !== false
  const hidden = new Set([
    ...(options.showSession === false ? ['five_hour'] : []),
    ...(options.showWeekly === false ? ['seven_day'] : []),
  ])

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await hydrate($)
    return result
  })

  // A /clear or resume keeps the process but starts the new conversation with
  // empty state and no session.start; redrawing lets the hint line notice.
  on('session.end', ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      $.clock.after(100, () => $.ui.invalidate('ui.render'))
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    // Stored every time: a new reset time with under a point of movement is
    // not reported in `changed`.
    await storeLimits($, e.rateLimits)
    if (e.rateLimits.length > 0) await $.store.set(LIMITS_KEY, e.rateLimits)
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
      .filter(l => !hidden.has(l.kind))
      .sort((a, b) => rank(a.kind) - rank(b.kind))
      .map(l => ({
        key: l.kind,
        label: LABELS[l.kind] ?? l.kind,
        percent: Math.round(l.percentUsed),
        extra: formatReset(l.resetsAt, now),
      }))

    const main = await read($, context)
    // Context is always set once a conversation is hydrated, so its absence
    // marks one that started without session.start (/clear, resume).
    if (main === null && !isHydrating) {
      isHydrating = true
      $.clock.after(0, () => {
        void hydrate($).finally(() => {
          isHydrating = false
        })
      })
    }
    const agentId = relayed?.agentId ?? null
    let ctx: Cell | null = null
    if (agentId === null) {
      if (main) ctx = contextCell(main.tokens, main.window, main.percent)
    } else {
      const agent = (await read($, agentContexts))[agentId]
      const tokens = agent?.tokens ?? 0
      ctx = contextCell(
        tokens,
        agentWindow(agent?.model, tokens, main, await read($, mainModel)),
      )
    }
    const left = ctx && showContext ? [ctx] : []
    const all = [...left, ...right]
    if (all.length === 0) return line

    const { Box, Text } = $.ui.resolve(e)
    const room = columns - LINE_INSET
    const widthFor = (n: number) => Math.floor((room - (n - 1) * COLUMN_GAP) / n)
    let count = Math.min(maxColumns, all.length)
    while (count > 1 && widthFor(count) < FIXED_WIDTH + MIN_BAR) count--
    const cellWidth = widthFor(count)
    // Every part but the bar is fixed-width so the bar only changes with the
    // column; on a very narrow one the reset/token column goes first.
    const showExtra = cellWidth >= FIXED_WIDTH + MIN_BAR
    const fixed = showExtra ? FIXED_WIDTH : FIXED_WIDTH - 1 - EXTRA_WIDTH
    const barWidth = Math.max(1, cellWidth - fixed)

    const cell = (c: Cell | undefined) => {
      if (!c) return null
      const percent = c.percent ?? 0
      const filled = Math.round((Math.min(percent, 100) / 100) * barWidth)
      return (
        <Box key={c.key}>
          <Text dimColor>{c.label.padEnd(LABEL_WIDTH)} </Text>
          <Text color={barColor(percent)}>{BAR.repeat(filled)}</Text>
          <Text dimColor>{BAR.repeat(barWidth - filled)}</Text>
          {c.percent === null ? (
            <Text dimColor>{'–'.padStart(PERCENT_WIDTH)}</Text>
          ) : (
            <Text>{`${c.percent}%`.padStart(PERCENT_WIDTH)}</Text>
          )}
          {showExtra ? <Text dimColor>{` ${c.extra.padEnd(EXTRA_WIDTH)}`}</Text> : null}
        </Box>
      )
    }

    // Two columns keep Context on its own on the left with the limits stacked
    // beside it; otherwise the bars fill the rows in order.
    const isSplit = count === 2 && left.length > 0 && right.length > 0
    const grid: (Cell | undefined)[][] = isSplit
      ? Array.from({ length: Math.max(left.length, right.length) }, (_, i) => [left[i], right[i]])
      : Array.from({ length: Math.ceil(all.length / count) }, (_, i) =>
          all.slice(i * count, (i + 1) * count),
        )

    return (
      <Box flexDirection="column">
        {line}
        {grid.map((row, i) => (
          <Box key={`row-${i}`}>
            {row.map((c, j) => (
              <Box key={`col-${j}`} width={cellWidth} marginLeft={j > 0 ? COLUMN_GAP : 0} flexShrink={0}>
                {cell(c)}
              </Box>
            ))}
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
