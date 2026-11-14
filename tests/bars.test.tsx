import { expect, mock, test } from 'claude-code/testing'

const HOUR = 3_600_000

function hint(columns: number) {
  return {
    plugin: 'usage-bars',
    surface: 'terminal',
    component: 'PromptHint',
    props: { isDraft: false, isWorking: false, hint: '⏵⏵ auto mode on (shift+tab to cycle)' },
    viewport: { columns, rows: 24 },
  } as const
}

function seed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    limits: [
      { kind: 'seven_day', percentUsed: 18.4 },
      { kind: 'five_hour', percentUsed: 62, resetsAt: new Date(Date.now() + 2 * HOUR).toISOString() },
    ],
    context: { tokens: 142_000, window: 1_000_000, percent: 14 },
    agentContexts: { sub: { tokens: 30_000, model: 'claude-haiku-4-5' } },
    mainModel: 'claude-opus-5-5',
    band: null,
    ...overrides,
  }
}

// An in-memory $.state, with the clock and the engine's own hint line stubbed.
function engine(on: any, state: Record<string, unknown>, { stubClock = true } = {}) {
  let version = 1
  on('state.get', (_: unknown, e: { key: string }) => ({ value: { value: state[e.key], version } }))
  on('state.set', (_: unknown, e: { key: string; value: unknown }) => {
    state[e.key] = e.value
    return { value: { isSet: true, version: ++version } }
  })
  if (stubClock) {
    on('clock.now', () => ({ value: Date.now() }))
    on('clock.after', () => ({ value: { cancel: () => {} } }))
  }
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine hint</Text>
  })
}

async function texts($: any, columns = 200) {
  const ui = await $.ui.mount(hint(columns))
  const found: string[] = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text)
  const drawn = await ui.drawn()
  await ui.unmount()
  return { found, drawn }
}

test('main view: context on the left, limits on the right', async ($, on) => {
  engine(on, seed())
  const { found: t } = await texts($)
  expect(t[0]).toBe('engine hint')
  expect(t[1]).toBe('Context ')
  expect(t.some(s => s.includes('142k/1.0M'))).toBe(true)
  expect(t.some(s => s.includes('62%'))).toBe(true)
})

test('subagent view: that agent context, its own model window when it is not the main one', async ($, on) => {
  engine(on, seed({ band: { agentId: 'sub', columns: 200 } }))
  const { found: t } = await texts($)
  expect(t.some(s => s.includes('30k/200k'))).toBe(true)
  expect(t.some(s => s.includes(' 15%'))).toBe(true)
})

test('a subagent on the main model is measured against the main window', async ($, on) => {
  engine(
    on,
    seed({
      band: { agentId: 'sub', columns: 200 },
      agentContexts: { sub: { tokens: 30_000, model: 'claude-opus-5-5' } },
    }),
  )
  const { found: t } = await texts($)
  expect(t.some(s => s.includes('30k/1.0M'))).toBe(true)
})

const SUBAGENT_WINDOWS = [
  ['claude-sonnet-5-5', '30k/1.0M'],
  ['claude-sonnet-4-6', '30k/1.0M'],
  ['claude-haiku-5-5', '30k/1.0M'],
  ['claude-fable-5-1', '30k/1.0M'],
  ['claude-haiku-4-5-20251001', '30k/200k'],
  ['claude-sonnet-4-5-20250929', '30k/200k'],
  ['claude-sonnet-4-20250514', '30k/200k'],
  ['claude-opus-4-5', '30k/200k'],
  ['claude-3-5-sonnet-20241022', '30k/200k'],
  ['something-else', '30k/200k'],
]

for (const [model, shown] of SUBAGENT_WINDOWS) {
  test(`a subagent on ${model} shows ${shown}`, async ($, on) => {
    engine(
      on,
      seed({
        band: { agentId: 'sub', columns: 200 },
        mainModel: 'claude-opus-5-5',
        agentContexts: { sub: { tokens: 30_000, model } },
      }),
    )
    const { found: t } = await texts($)
    expect(t.some(s => s.includes(shown))).toBe(true)
  })
}

test('a subagent past the standard window is measured against the large one', async ($, on) => {
  engine(
    on,
    seed({
      band: { agentId: 'sub', columns: 200 },
      agentContexts: { sub: { tokens: 250_000, model: 'claude-sonnet-5-5' } },
    }),
  )
  const { found: t } = await texts($)
  expect(t.some(s => s.includes('250k/1.0M'))).toBe(true)
  expect(t.some(s => s.includes(' 25%'))).toBe(true)
})

test('a subagent is sized by its own model when the main model is not known', async ($, on) => {
  engine(
    on,
    seed({
      band: { agentId: 'sub', columns: 200 },
      mainModel: null,
      agentContexts: { sub: { tokens: 30_000, model: 'claude-sonnet-5-5' } },
    }),
  )
  const { found: t } = await texts($)
  expect(t.some(s => s.includes('30k/1.0M'))).toBe(true)
})

test('a subagent with no steps yet shows an empty context bar', async ($, on) => {
  engine(on, seed({ band: { agentId: 'fresh', columns: 200 } }))
  const { found: t } = await texts($)
  expect(t.some(s => s.includes('0k/200k'))).toBe(true)
})

test('tokens just under a million format as 1.0M', async ($, on) => {
  engine(on, seed({ context: { tokens: 999_700, window: 1_000_000, percent: 100 } }))
  const { found: t } = await texts($)
  expect(t.some(s => s.includes('1.0M/1.0M'))).toBe(true)
})

// Cells a drawn node takes on one line; a fixed-width Box takes at least its width.
function cells(node: any): number {
  if (typeof node === 'string') return [...node].length
  if (!node || typeof node !== 'object') return 0
  const kids: any[] = node.children ?? []
  const inner =
    node.props?.flexDirection === 'column'
      ? Math.max(0, ...kids.map(cells))
      : kids.reduce((n, k) => n + cells(k), 0)
  return Math.max(node.props?.width ?? 0, inner) + (node.props?.marginLeft ?? 0)
}

async function rowWidths($: any, columns: number) {
  const { drawn } = await texts($, columns)
  return (drawn.children as any[]).slice(1).map(cells)
}

for (const columns of [200, 120, 80, 71, 60, 40]) {
  test(`no bar row is wider than the hint line at ${columns} columns`, async ($, on) => {
    engine(on, seed())
    const widths = await rowWidths($, columns)
    expect(widths.length).toBeGreaterThan(0)
    for (const w of widths) expect(w).toBeLessThanOrEqual(columns - 4)
  })
}

test('the relayed band width wins over the viewport', async ($, on) => {
  engine(on, seed({ band: { agentId: null, columns: 90 } }))
  for (const w of await rowWidths($, 200)) expect(w).toBeLessThanOrEqual(86)
})

test('a window whose reset passed is stored as empty at session start', async ($, on) => {
  const state = seed()
  engine(on, state)
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: {
      startedAt: Date.now(),
      context: { window: 200_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 62, resetsAt: new Date(Date.now() - HOUR).toISOString() },
        { kind: 'seven_day', percentUsed: 18, resetsAt: new Date(Date.now() + 48 * HOUR).toISOString() },
      ],
    },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const stored = state.limits as { kind: string; percentUsed: number }[]
  expect(stored.find(l => l.kind === 'five_hour')?.percentUsed).toBe(0)
  expect(stored.find(l => l.kind === 'seven_day')?.percentUsed).toBe(18)
})

function startWith(on: any, rateLimits: unknown[], saved: Record<string, unknown>) {
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: Date.now(), context: { window: 1_000_000 }, rateLimits },
  }))
  on('store.get', (_: unknown, e: { key: string }) => ({ value: saved[e.key] }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    saved[e.key] = e.value
    return { value: undefined }
  })
}

test('after a /clear or resume the last known limits show at once', async ($, on) => {
  const state = seed({ limits: [] })
  engine(on, state)
  startWith(on, [], {
    lastLimits: [
      { kind: 'five_hour', percentUsed: 40, resetsAt: new Date(Date.now() - HOUR).toISOString() },
      { kind: 'seven_day', percentUsed: 25, resetsAt: new Date(Date.now() + 48 * HOUR).toISOString() },
    ],
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const stored = state.limits as { kind: string; percentUsed: number }[]
  expect(stored.find(l => l.kind === 'five_hour')?.percentUsed).toBe(0)
  expect(stored.find(l => l.kind === 'seven_day')?.percentUsed).toBe(25)
})

test('a fresh reading is saved for the next session', async ($, on) => {
  const saved: Record<string, unknown> = {}
  engine(on, seed())
  startWith(on, [{ kind: 'five_hour', percentUsed: 12 }], saved)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(saved.lastLimits).toEqual([{ kind: 'five_hour', percentUsed: 12 }])
})

test('before the first reply the context bar is drawn empty', async ($, on) => {
  engine(on, seed({ context: { window: 1_000_000 } }))
  const { found: t } = await texts($)
  expect(t[1]).toBe('Context ')
  expect(t.some(s => s.includes('–/1.0M'))).toBe(true)
  expect(t.some(s => s.trim() === '–')).toBe(true)
})

test('a conversation that started without session.start fills itself in', async ($, on) => {
  const state: Record<string, unknown> = { limits: [], context: null, agentContexts: {}, mainModel: null, band: null }
  engine(on, state, { stubClock: false })
  const clock = mock.clock(on, { now: Date.now() })
  mock.store(on, {
    lastLimits: [{ kind: 'seven_day', percentUsed: 25, resetsAt: new Date(Date.now() + 48 * HOUR).toISOString() }],
  })
  on('session.usage', () => ({
    value: { startedAt: Date.now(), context: { window: 1_000_000 }, rateLimits: [] },
  }))
  await texts($)
  await clock.settle()
  expect((state.limits as unknown[]).length).toBe(1)
  expect(state.context).toEqual({ window: 1_000_000 })
})

// The label in each column of each bar row, '' for an empty column.
function firstText(node: any): string {
  if (typeof node === 'string') return node
  for (const k of node?.children ?? []) {
    const t = firstText(k)
    if (t.trim()) return t
  }
  return ''
}

async function grid($: any, columns = 200) {
  const { drawn } = await texts($, columns)
  return (drawn.children as any[]).slice(1).map(row => (row.children as any[]).map(c => firstText(c).trim()))
}

test('two columns by default: context on the left, limits stacked on the right', async ($, on) => {
  engine(on, seed())
  expect(await grid($)).toEqual([
    ['Context', 'Session'],
    ['', 'Weekly'],
  ])
})

test('one column stacks every bar', { options: { layout: 'one-column' } }, async ($, on) => {
  engine(on, seed())
  expect(await grid($)).toEqual([['Context'], ['Session'], ['Weekly']])
})

test('three columns put each bar in its own column', { options: { layout: 'three-columns' } }, async ($, on) => {
  engine(on, seed())
  expect(await grid($)).toEqual([['Context', 'Session', 'Weekly']])
})

test('three columns wrap a fourth bar onto the next row', { options: { layout: 'three-columns' } }, async ($, on) => {
  engine(on, seed({ limits: [...(seed().limits as unknown[]), { kind: 'spend_limit', percentUsed: 5 }] }))
  expect(await grid($)).toEqual([['Context', 'Session', 'Weekly'], ['Spend']])
})

test('three columns fall back to two where three do not fit', { options: { layout: 'three-columns' } }, async ($, on) => {
  engine(on, seed())
  expect(await grid($, 99)).toEqual([
    ['Context', 'Session'],
    ['', 'Weekly'],
  ])
})

test('an unknown layout counts as the default', { options: { layout: 'grid' } }, async ($, on) => {
  engine(on, seed())
  expect(await grid($)).toEqual([
    ['Context', 'Session'],
    ['', 'Weekly'],
  ])
})

test('two columns without context put the limits side by side', { options: { showContext: false } }, async ($, on) => {
  engine(on, seed())
  expect(await grid($)).toEqual([['Session', 'Weekly']])
})

test(
  'three columns with a bar hidden leave no empty column',
  { options: { layout: 'three-columns', showWeekly: false } },
  async ($, on) => {
    engine(on, seed())
    const { drawn } = await texts($)
    const row = (drawn.children as any[])[1]
    expect(row.children.map((c: any) => firstText(c).trim())).toEqual(['Context', 'Session'])
    expect(row.children[0].props.width).toBe(Math.floor((200 - 4 - 3) / 2))
  },
)

test('hidden limits are not drawn', { options: { layout: 'one-column', showSession: false } }, async ($, on) => {
  engine(on, seed())
  const { found } = await texts($)
  expect(found.some(s => s.startsWith('Session'))).toBe(false)
  expect(await grid($)).toEqual([['Context'], ['Weekly']])
})

test('context alone takes the whole row', { options: { showSession: false, showWeekly: false } }, async ($, on) => {
  engine(on, seed())
  const { drawn } = await texts($)
  const rows = (drawn.children as any[]).slice(1)
  expect(rows.length).toBe(1)
  expect(rows[0].children[0].props.width).toBe(200 - 4)
})

test(
  'with every bar hidden only the hint line is drawn',
  { options: { showContext: false, showSession: false, showWeekly: false } },
  async ($, on) => {
    engine(on, seed())
    const { found } = await texts($)
    expect(found).toEqual(['engine hint'])
  },
)

test('hiding context still fills the limits in after a /clear', { options: { showContext: false } }, async ($, on) => {
  const state: Record<string, unknown> = { limits: [], context: null, agentContexts: {}, mainModel: null, band: null }
  engine(on, state, { stubClock: false })
  const clock = mock.clock(on, { now: Date.now() })
  mock.store(on, {
    lastLimits: [{ kind: 'seven_day', percentUsed: 25, resetsAt: new Date(Date.now() + 48 * HOUR).toISOString() }],
  })
  on('session.usage', () => ({
    value: { startedAt: Date.now(), context: { window: 1_000_000 }, rateLimits: [] },
  }))
  await texts($)
  await clock.settle()
  expect((state.limits as unknown[]).length).toBe(1)
})

for (const layout of ['one-column', 'three-columns']) {
  for (const columns of [200, 120, 100, 80, 71, 60, 40]) {
    test(`${layout}: no bar row is wider than the hint line at ${columns} columns`, { options: { layout } }, async ($, on) => {
      engine(on, seed())
      const widths = await rowWidths($, columns)
      expect(widths.length).toBeGreaterThan(0)
      for (const w of widths) expect(w).toBeLessThanOrEqual(columns - 4)
    })
  }
}

const DAY = 24 * HOUR
// A window that started 2026-11-12 00:00Z; noon on its second day is day 1.
const RESETS_AT = '2026-11-19T00:00:00.000Z'
const DAY_1_NOON = Date.parse('2026-11-13T12:00:00.000Z')
// 200 columns, two columns: (196 - 3) / 2 = 96 per cell, less 22 fixed.
const BAR_WIDTH = 74

// Each run of the Weekly bar: [colour, length], the dim track as 'dim'.
function weeklyRuns(drawn: any): [string, number][] {
  const find = (node: any): any =>
    !node || typeof node !== 'object'
      ? undefined
      : firstText(node).trim() === 'Weekly' && (node.children ?? []).length > 3
        ? node
        : (node.children ?? []).map(find).find(Boolean)
  const cell = find(drawn)
  return (cell.children as any[])
    .slice(1)
    .filter(t => /^▇+$/.test(firstText(t)))
    .map(t => [t.props?.dimColor ? 'dim' : t.props?.color, [...firstText(t)].length])
}

function paceSession(on: any, weekly: number, saved: Record<string, unknown>) {
  const reading = [{ kind: 'seven_day', percentUsed: weekly, resetsAt: RESETS_AT }]
  const state = seed({ limits: [] })
  engine(on, state, { stubClock: false })
  const clock = mock.clock(on, { now: DAY_1_NOON })
  startWith(on, reading, saved)
  return { state, clock }
}

const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

test('weekly pace is off unless switched on', async ($, on) => {
  paceSession(on, 5, { weeklyPace: { resetsAt: RESETS_AT, day: 1, usedAtStart: 5 } })
  await start($)
  const { drawn } = await texts($)
  expect(weeklyRuns(drawn).map(r => r[0])).toEqual(['success', 'dim'])
})

test(
  'weekly pace splits what was left at the start of the day over the days left',
  { options: { showWeeklyPace: true } },
  async ($, on) => {
    const saved: Record<string, unknown> = {
      lastLimits: [{ kind: 'seven_day', percentUsed: 5, resetsAt: RESETS_AT }],
    }
    paceSession(on, 8, saved)
    await start($)
    expect(saved.weeklyPace).toEqual({ resetsAt: RESETS_AT, day: 1, usedAtStart: 5 })
    // 8% used, budget to 5 + 95 / 6 = 20.8%.
    const used = Math.round(0.08 * BAR_WIDTH)
    const budget = Math.round((20.8333 / 100) * BAR_WIDTH)
    const { drawn } = await texts($)
    expect(weeklyRuns(drawn)).toEqual([
      ['success', used],
      ['subtle', budget - used],
      ['dim', BAR_WIDTH - budget],
    ])
  },
)

test('a snapshot taken earlier today is kept', { options: { showWeeklyPace: true } }, async ($, on) => {
  const snapshot = { resetsAt: RESETS_AT, day: 1, usedAtStart: 2 }
  const saved: Record<string, unknown> = {
    weeklyPace: snapshot,
    lastLimits: [{ kind: 'seven_day', percentUsed: 9, resetsAt: RESETS_AT }],
  }
  paceSession(on, 10, saved)
  await start($)
  expect(saved.weeklyPace).toEqual(snapshot)
})

test('the next day recalculates from where the day ended', { options: { showWeeklyPace: true } }, async ($, on) => {
  const saved: Record<string, unknown> = {
    lastLimits: [{ kind: 'seven_day', percentUsed: 5, resetsAt: RESETS_AT }],
  }
  const { state, clock } = paceSession(on, 5, saved)
  await start($)
  const reading = [{ kind: 'seven_day', percentUsed: 30, resetsAt: RESETS_AT }]
  state.limits = reading
  saved.lastLimits = reading
  await clock.advance(DAY)
  expect(saved.weeklyPace).toEqual({ resetsAt: RESETS_AT, day: 2, usedAtStart: 30 })
})

test('a snapshot from the last window is not reused', { options: { showWeeklyPace: true } }, async ($, on) => {
  const old = '2026-11-12T00:00:00.000Z'
  const saved: Record<string, unknown> = {
    weeklyPace: { resetsAt: old, day: 1, usedAtStart: 60 },
    lastLimits: [{ kind: 'seven_day', percentUsed: 90, resetsAt: old }],
  }
  paceSession(on, 4, saved)
  await start($)
  expect(saved.weeklyPace).toEqual({ resetsAt: RESETS_AT, day: 1, usedAtStart: 4 })
})

test('over today’s budget the bar shows no budget left', { options: { showWeeklyPace: true } }, async ($, on) => {
  paceSession(on, 40, { weeklyPace: { resetsAt: RESETS_AT, day: 1, usedAtStart: 5 } })
  await start($)
  const { drawn } = await texts($)
  expect(weeklyRuns(drawn).map(r => r[0])).toEqual(['success', 'dim'])
})

test('a budget too thin to round to a cell still gets one', { options: { showWeeklyPace: true } }, async ($, on) => {
  // 16% used, budget to 0 + 100 / 6 = 16.7%: both round to cell 12 of 74.
  paceSession(on, 16, { weeklyPace: { resetsAt: RESETS_AT, day: 1, usedAtStart: 0 } })
  await start($)
  const { drawn } = await texts($)
  expect(weeklyRuns(drawn)).toEqual([
    ['success', 12],
    ['subtle', 1],
    ['dim', BAR_WIDTH - 13],
  ])
})

test('switched on mid-session, the mark shows without a new reading', { options: { showWeeklyPace: true } }, async ($, on) => {
  const state = seed({ limits: [{ kind: 'seven_day', percentUsed: 5, resetsAt: RESETS_AT }] })
  engine(on, state, { stubClock: false })
  const clock = mock.clock(on, { now: DAY_1_NOON })
  mock.store(on, {})
  await texts($)
  await clock.settle()
  expect(state.pace).toEqual({ resetsAt: RESETS_AT, day: 1, usedAtStart: 5 })
})
