import { expect, test } from 'claude-code/testing'

const HINT = {
  plugin: 'usage-bars',
  surface: 'terminal',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '⏵⏵ auto mode on (shift+tab to cycle)' },
  viewport: { columns: 200, rows: 24 },
} as const

function seed(viewedAgent: string | null): Record<string, unknown> {
  return {
    limits: [
      { kind: 'seven_day', percentUsed: 18.4 },
      { kind: 'five_hour', percentUsed: 62, resetsAt: new Date(Date.now() + 7_200_000).toISOString() },
    ],
    context: { tokens: 142_000, window: 1_000_000, percent: 14 },
    agentContexts: { sub: { tokens: 30_000, model: 'claude-haiku-5-5' } },
    mainModel: 'claude-opus-5-5',
    viewedAgent,
  }
}

async function texts($: any, on: any, viewedAgent: string | null) {
  const state = seed(viewedAgent)
  on('state.get', (_: unknown, e: { key: string }) => ({ value: { value: state[e.key], version: 1 } }))
  on('clock.now', () => ({ value: Date.now() }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine hint</Text>
  })
  const ui = await $.ui.mount(HINT)
  const found = (await ui.findAll({ type: 'Text' })).map((t: { text: string }) => t.text)
  await ui.unmount()
  return found
}

test('main view: context on the left, limits on the right', async ($, on) => {
  const t = await texts($, on, null)
  expect(t[0]).toBe('engine hint')
  expect(t[1]).toBe('Context ')
  expect(t.some(s => s.includes('142k/1.0M'))).toBe(true)
  expect(t.some(s => s.includes('62%'))).toBe(true)
})

test('subagent view: that agent context, standard window for another model', async ($, on) => {
  const t = await texts($, on, 'sub')
  expect(t.some(s => s.includes('30k/200k'))).toBe(true)
  expect(t.some(s => s.includes(' 15%'))).toBe(true)
})
