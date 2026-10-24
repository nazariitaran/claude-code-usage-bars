import { expect, test } from 'claude-code/testing'

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
    agentContexts: { sub: { tokens: 30_000, model: 'claude-haiku-5-5' } },
    mainModel: 'claude-opus-5-5',
    band: null,
    ...overrides,
  }
}

// An in-memory $.state, with the clock and the engine's own hint line stubbed.
function engine(on: any, state: Record<string, unknown>) {
  let version = 1
  on('state.get', (_: unknown, e: { key: string }) => ({ value: { value: state[e.key], version } }))
  on('state.set', (_: unknown, e: { key: string; value: unknown }) => {
    state[e.key] = e.value
    return { value: { isSet: true, version: ++version } }
  })
  on('clock.now', () => ({ value: Date.now() }))
  on('clock.after', () => ({ value: { cancel: () => {} } }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine hint</Text>
  })
}

async function texts($: any, columns = 200) {
  const ui = await $.ui.mount(hint(columns))
  const found = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text)
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

test('subagent view: that agent context, standard window for another model', async ($, on) => {
  engine(on, seed({ band: { agentId: 'sub', columns: 200 } }))
  const { found: t } = await texts($)
  expect(t.some(s => s.includes('30k/200k'))).toBe(true)
  expect(t.some(s => s.includes(' 15%'))).toBe(true)
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
