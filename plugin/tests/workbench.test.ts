import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin, PromptSubmitInput, UiPane } from 'claude-code'

const ROOT = '/synthetic'
const ROWS = [
  { id: 'DEMO-1', title: 'First synthetic task', status: 'Waiting Review' },
  { id: 'DEMO-2', title: 'Second synthetic task', status: 'To Do' },
]
const task = (id: string, criterion = `Criterion of ${id}`, dod = `DoD of ${id}`) => ({
  ...ROWS.find(row => row.id === id), description: 'Synthetic description',
  path: `backlog/tasks/${id.toLowerCase()}.md`, dependencies: [],
  acceptanceCriteria: [{ index: 1, text: criterion, checked: false }],
  definitionOfDone: [{ index: 1, text: dod, checked: true }],
})

async function setup<S extends 'terminal' | 'desktop' | 'mobile' = 'terminal'>($: Engine, on: On, surface: S = 'terminal' as S) {
  const host = {
    panes: [] as UiPane[], root: ROOT, sessionId: 'session-1', changed: false,
    failReads: false, collision: false, drop: false, reads: [] as string[][], submitted: [] as PromptSubmitInput[],
    heldId: '', release: undefined as (() => void) | undefined,
    onHeld: undefined as (() => void) | undefined,
    writes: [] as { gen: number; pending: boolean }[],
    description: 'Synthetic description', acText: '', dodText: '', rows: ROWS.map(row => ({ ...row })),
    holdIdentity: false, identityStarted: undefined as (() => void) | undefined,
    releaseIdentity: undefined as (() => void) | undefined,
  }
  on('state.set', { plugin: 'backlog-workbench', key: 'app' }, ($, e, next) => {
    host.writes.push({ gen: e.value.detailGen, pending: e.value.pendingDetail })
    return next(e)
  })
  on('session.id', async () => {
    const id = host.sessionId
    if (host.holdIdentity) {
      host.holdIdentity = false
      await new Promise<void>(resolve => { host.releaseIdentity = resolve; host.identityStarted?.() })
    }
    return { value: id }
  })
  on('session.root', () => ({ value: host.root }))
  on('session.cwd', () => ({ value: host.root }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('ui.render', () => ({ type: 'Box', children: [] }))
  on('ui.panes', () => ({ value: host.panes }))
  on('ui.open', ($, e) => {
    host.panes = [{ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true }]
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => { host.panes = []; return { value: undefined } })
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', ($, e) => ({ value: e.path === `${host.root}/backlog/config.yml` || e.path === '/opt/homebrew/bin/node' || e.path === '/usr/bin/sandbox-exec' }))
  on('fs.stat', ($, e) => ({ value: { kind: e.path.endsWith('config.yml') ? 'file' : 'dir', size: 100, mtimeMs: 1, isLink: false, realPath: e.path } }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', async ($, e) => {
    const argv = [...e.argv]
    host.reads.push(argv)
    if (host.failReads) return { value: { exitCode: 1, isStdoutTruncated: false, isStderrTruncated: false, stdout: '', stderr: 'Synthetic read failure' } }
    if (argv.includes('list')) {
      const blockedCLI = host.collision && argv.some(arg => arg.endsWith('/backlog'))
      return { value: {
        exitCode: blockedCLI ? 1 : 0, isStdoutTruncated: false, isStderrTruncated: false,
        stdout: blockedCLI ? '' : JSON.stringify({ schemaVersion: 1, kind: 'task-list', tasks: host.rows,
          conflicts: host.collision ? [{ id: 'DEMO-1', paths: ['backlog/tasks/demo-1.md', 'backlog/archive/tasks/demo-1.md'] }] : [] }),
        stderr: blockedCLI ? 'WARNING duplicate task ID DEMO-1' : '',
      } }
    }
    if (host.collision && argv.includes('DEMO-1')) return { value: { exitCode: 1, isStdoutTruncated: false, isStderrTruncated: false, stdout: '', stderr: 'Ambiguous task ID DEMO-1' } }
    const id = argv[argv.indexOf('view') + 1]!
    if (id === host.heldId) await new Promise<void>(resolve => { host.release = resolve; host.onHeld?.() })
    const result = { ...task(id, host.acText || undefined, host.dodText || undefined), ...host.rows.find(row => row.id === id), description: host.description }
    if (host.changed) result.title = 'Changed after preparation'
    return { value: { exitCode: 0, isStdoutTruncated: false, isStderrTruncated: false, stdout: JSON.stringify({ schemaVersion: 1, kind: 'task-view', task: result }), stderr: '' } }
  })
  on('prompt.submit', ($, e) => {
    if (host.drop) return { drop: 'Another hook refused' }
    host.submitted.push(e)
    return { text: e.text, context: e.context, origin: e.origin }
  })
  await $.session.start({ surface, isInteractive: true, cwd: ROOT })
  const footer = await $.ui.mount({
    plugin: 'backlog-workbench', surface, component: 'SessionMode',
    props: { modes: [] },
  })
  await footer.press({ key: 'backlog-toggle' })
  const pane = await $.ui.mount({
    plugin: 'backlog-workbench', surface, component: 'Pane', requestId: 'backlog',
    props: { title: 'Backlog', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  const select = async (id = 'DEMO-2') => {
    await pane.press({ key: 'view-navigator' })
    await pane.press({ key: `task-${id}` })
    await pane.press({ key: 'view-review' })
  }
  const submit = (text = 'Inspect this task', origin: PromptOrigin = { kind: 'composer' }) =>
    $.prompt.submit({ text, origin, wait: false, context: ['Other plugin context'] })
  return { host, pane, footer, select, submit }
}

// Body text nests colored Text spans, whose shown text find({ text }) does not
// recompose; these helpers read the drawn tree instead.
type TreeNode = string | { type?: string; props?: { color?: string } & Record<string, unknown>; children?: TreeNode[] }

const recompose = (node: TreeNode): string => typeof node === 'string' ? node : (node.children ?? []).map(recompose).join('')
const spansOf = (node: TreeNode, color: string, into: string[] = []): string[] => {
  if (typeof node === 'string') return into
  if (node.type === 'Text' && node.props?.color === color) {
    into.push((node.children ?? []).filter((child): child is string => typeof child === 'string').join(''))
  }
  for (const child of node.children ?? []) spansOf(child, color, into)
  return into
}
const depthOf = (node: TreeNode): number => typeof node === 'string' ? 0
  : 1 + Math.max(0, ...(node.children ?? []).map(depthOf))
const drawnTree = async (pane: { drawn: () => Promise<unknown> }): Promise<TreeNode> => await pane.drawn() as TreeNode
const recomposed = async (pane: { drawn: () => Promise<unknown> }) => recompose(await drawnTree(pane))
const textBlocks = (node: TreeNode): string[] => typeof node === 'string' ? [node]
  : node.type === 'Text' ? [recompose(node)] : (node.children ?? []).flatMap(textBlocks)
const nodeCount = (node: TreeNode): number => typeof node === 'string' ? 1
  : 1 + (node.children ?? []).reduce((count, child) => count + nodeCount(child), 0)

type ElementNode = Extract<TreeNode, object>
const elementsOf = (node: TreeNode, type: string, into: ElementNode[] = []): ElementNode[] => {
  if (typeof node === 'string') return into
  if (node.type === type) into.push(node)
  for (const child of node.children ?? []) elementsOf(child, type, into)
  return into
}
const boxesOf = (node: TreeNode): ElementNode[] => elementsOf(node, 'Box')
const taskButtons = (node: TreeNode): ElementNode[] => elementsOf(node, 'Button')
  .filter(button => typeof button.props?.key === 'string' && (button.props.key as string).startsWith('task-'))
const textChildren = (node: ElementNode): ElementNode[] =>
  (node.children ?? []).filter((child): child is ElementNode => typeof child !== 'string' && child.type === 'Text')
const keyOrder = (node: TreeNode): string[] => {
  if (typeof node === 'string') return []
  const own = typeof node.props?.key === 'string' ? [node.props.key as string] : []
  return [...own, ...(node.children ?? []).flatMap(keyOrder)]
}
const framedContent = async (pane: { drawn: () => Promise<unknown> }): Promise<ElementNode | undefined> =>
  boxesOf(await drawnTree(pane)).find(box => box.props?.borderStyle === 'single')

for (const surface of ['terminal', 'desktop'] as const) {
  test(`workbench preserves selection across views and toggles on ${surface}`, async ($, on) => {
    const { host, pane, footer, select } = await setup($, on, surface)
    await select()
    expect(await recomposed(pane)).toMatch(/Criterion of DEMO-2/)
    await pane.press({ key: 'tab-dod' })
    expect(await recomposed(pane)).toMatch(/DoD of DEMO-2/)
    const reads = host.reads.length
    await footer.press({ key: 'backlog-toggle' })
    expect(host.panes).toEqual([])
    await footer.press({ key: 'backlog-toggle' })
    expect(host.panes.map(p => p.id)).toEqual(['backlog'])
    expect(await recomposed(pane)).toMatch(/DoD of DEMO-2/)
    expect(host.reads.length).toBe(reads)
  })
}

test('the footer names the selected task and prepared attachment across close and reopen', async ($, on) => {
  const { pane, footer, select } = await setup($, on)
  await select()
  expect(await footer.find({ type: 'Text', text: 'DEMO-2' })).toBeDefined()
  expect(await footer.find({ type: 'Text', text: 'attachment' })).toBeUndefined()
  await pane.press({ key: 'attach' })
  expect(await footer.find({ type: 'Text', text: 'DEMO-2 · attachment prepared' })).toBeDefined()
  await footer.press({ key: 'backlog-toggle' })
  await footer.press({ key: 'backlog-toggle' })
  expect(await footer.find({ type: 'Text', text: 'DEMO-2 · attachment prepared' })).toBeDefined()
})

test('explicit attachment is added once and preserves other plugin context', async ($, on) => {
  const { host, pane, select, submit } = await setup($, on)
  await select()
  await pane.press({ key: 'attach' })
  const first = await submit()
  expect(first.drop).toBeUndefined()
  expect(first.context).toHaveLength(2)
  expect(first.context?.[0]).toBe('Other plugin context')
  expect(first.context?.[1]).toContain('DEMO-2')
  const reads = host.reads.length
  const second = await submit('Next unrelated message')
  expect(second.context).toEqual(['Other plugin context'])
  expect(host.reads.length).toBe(reads)
})

test('notifications and slash text do not consume the prepared attachment', async ($, on) => {
  const { pane, select, submit } = await setup($, on)
  await select()
  await pane.press({ key: 'attach' })
  for (const origin of [{ kind: 'task-notification' }, { kind: 'scheduled-trigger' }, { kind: 'peer' }, { kind: 'sdk' }] as const) {
    expect((await submit('Automatic message', origin)).context).toEqual(['Other plugin context'])
  }
  for (const text of ['/backlog', '  /clear', '/absolute/path']) {
    expect((await submit(text)).context).toEqual(['Other plugin context'])
  }
  expect((await submit('Human message', { kind: 'bridge' })).context).toHaveLength(2)
})

test('changed data refuses delivery until the user removes or prepares again', async ($, on) => {
  const { host, pane, select, submit } = await setup($, on)
  await select()
  await pane.press({ key: 'attach' })
  host.changed = true
  expect((await submit()).drop).toBeDefined()
  expect(host.submitted).toHaveLength(0)
  expect((await submit('Retry without re-preparing')).drop).toBeDefined()
  expect(host.submitted).toHaveLength(0)
  await pane.press({ key: 'remove' })
  expect((await submit('Without attachment')).context).toEqual(['Other plugin context'])
})

test('downstream refusal does not automatically rearm the attachment', async ($, on) => {
  const { host, pane, select, submit } = await setup($, on)
  await select()
  await pane.press({ key: 'attach' })
  host.drop = true
  expect((await submit()).drop).toBe('Another hook refused')
  host.drop = false
  expect((await submit()).drop).toBeDefined()
  expect(host.submitted).toHaveLength(0)
})

test('switching repository refuses an armed prompt rather than leaking task context', async ($, on) => {
  const { host, pane, select, submit } = await setup($, on)
  await select()
  await pane.press({ key: 'attach' })
  host.root = '/another-project'
  expect((await submit()).drop).toBeDefined()
  expect(host.submitted).toHaveLength(0)
})

test('the same one-shot attachment cannot enter two overlapping prompts', async ($, on) => {
  const { host, pane, select, submit } = await setup($, on)
  await select()
  await pane.press({ key: 'attach' })
  host.heldId = 'DEMO-2'
  let start!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  host.onHeld = start
  const first = submit('First message')
  await started
  const second = await submit('Second message')
  expect(second.drop).toBeDefined()
  host.release?.()
  expect((await first).context).toHaveLength(2)
  expect(host.submitted).toHaveLength(1)
})

test('a slower earlier selection cannot replace the latest task', async ($, on) => {
  const { host, pane } = await setup($, on)
  await pane.press({ key: 'view-navigator' })
  host.heldId = 'DEMO-1'
  const started = new Promise<void>(resolve => { host.onHeld = resolve })
  const first = pane.press({ key: 'task-DEMO-1' })
  await started
  await pane.press({ key: 'back-to-list' })
  await pane.press({ key: 'task-DEMO-2' })
  host.release?.()
  await first
  await pane.press({ key: 'view-review' })
  expect(await recomposed(pane)).toMatch(/Criterion of DEMO-2/)
  expect(await recomposed(pane)).not.toMatch(/Criterion of DEMO-1/)
})

for (const closeFrom of ['footer', 'pane'] as const) {
test(`closing from ${closeFrom} during a detail read discards its response`, async ($, on) => {
  const { host, pane, footer } = await setup($, on)
  await pane.press({ key: 'view-navigator' })
  host.heldId = 'DEMO-1'
  const started = new Promise<void>(resolve => { host.onHeld = resolve })
  const first = pane.press({ key: 'task-DEMO-1' })
  await started
  const writesBefore = host.writes.length
  if (closeFrom === 'footer') await footer.press({ key: 'backlog-toggle' })
  else await pane.press({ key: 'backlog-close' })
  expect(host.writes.slice(writesBefore).some(write => !write.pending)).toBe(true)
  host.release?.()
  await first
  await footer.press({ key: 'backlog-toggle' })
  await pane.press({ key: 'view-review' })
  expect(await recomposed(pane)).not.toMatch(/Criterion of DEMO-1/)
})
}

test('refresh failure clears selectable cached rows and refuses attachment', async ($, on) => {
  const { host, pane, select, submit } = await setup($, on)
  await select()
  await pane.press({ key: 'attach' })
  host.failReads = true
  await pane.press({ key: 'refresh' })
  await pane.press({ key: 'view-navigator' })
  expect(await pane.find({ key: 'task-DEMO-2' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /Synthetic read failure/ })).toBeDefined()
  expect((await submit()).drop).toBeDefined()
  expect(host.submitted).toHaveLength(0)
})

test('filters survive review and close without additional reads', async ($, on) => {
  const { host, pane, footer } = await setup($, on)
  await pane.press({ key: 'view-navigator' })
  await pane.input({ key: 'query', text: 'First', kind: 'change' })
  await pane.select({ key: 'status', value: '0' })
  const reads = host.reads.length
  await pane.press({ key: 'view-review' })
  await footer.press({ key: 'backlog-toggle' })
  await footer.press({ key: 'backlog-toggle' })
  await pane.press({ key: 'view-navigator' })
  expect(await pane.find({ key: 'task-DEMO-1' })).toBeDefined()
  expect(await pane.find({ key: 'task-DEMO-2' })).toBeUndefined()
  expect(host.reads.length).toBe(reads)
})

test('a reload invalidates an attachment without resetting the chosen view', async ($, on) => {
  const { pane, select, submit } = await setup($, on)
  await select()
  await pane.press({ key: 'attach' })
  await pane.press({ key: 'view-navigator' })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: ROOT })
  expect(await pane.find({ key: 'query' })).toBeDefined()
  expect((await submit()).drop).toBeDefined()
})

test('clear resets the old attachment before a new session without session.start', async ($, on) => {
  const { host, pane, select, submit } = await setup($, on)
  await select()
  await pane.press({ key: 'attach' })
  await $.session.end({ reason: 'clear', sessionId: host.sessionId, resume: { id: host.sessionId } })
  host.sessionId = 'session-2'
  const reads = host.reads.length
  expect((await submit()).context).toEqual(['Other plugin context'])
  expect(host.reads.length).toBe(reads)
})

test('oversized preparation records failure and blocks bare delivery', async ($, on) => {
  const { host, pane, select, submit } = await setup($, on)
  host.description = 'x'.repeat(91000)
  await select()
  await pane.press({ key: 'attach' }).catch(() => undefined)
  expect((await submit()).drop).toBeDefined()
  expect(host.submitted).toHaveLength(0)
  expect(await pane.find({ type: 'Text', text: /exceeds 90000/ })).toBeDefined()
  await pane.select({ key: 'context', value: 'short' })
  await pane.press({ key: 'attach' })
  expect((await submit()).context).toHaveLength(2)
})

for (const after of ['select', 'close'] as const) {
  test(`selection waiting for identity cannot outlive a later ${after}`, async ($, on) => {
    const { host, pane, footer } = await setup($, on)
    await pane.press({ key: 'view-navigator' })
    host.holdIdentity = true
    const started = new Promise<void>(resolve => { host.identityStarted = resolve })
    const first = pane.press({ key: 'task-DEMO-1' })
    await started
    if (after === 'select') {
      await pane.press({ key: 'back-to-list' })
      await pane.press({ key: 'task-DEMO-2' })
    } else await footer.press({ key: 'backlog-toggle' })
    host.releaseIdentity?.()
    await first
    if (after === 'close') await footer.press({ key: 'backlog-toggle' })
    await pane.press({ key: 'view-review' })
    expect(await recomposed(pane)).not.toMatch(/Criterion of DEMO-1/)
    if (after === 'select') expect(await recomposed(pane)).toMatch(/Criterion of DEMO-2/)
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`large and escaped statuses remain filterable without changing task data on ${surface}`, async ($, on) => {
    const { host, pane, submit } = await setup($, on, surface)
    const longStatus = 'x'.repeat(10001)
    const escapedStatus = '\u0000'.repeat(2000)
    host.rows = [{ ...ROWS[0]!, status: longStatus }, { ...ROWS[1]!, status: escapedStatus }]
    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'view-navigator' })
    const tree = await pane.drawn()
    const selector = await pane.find({ key: 'status' })
    const options = selector!.props.options as { value: string; label: string }[]
    expect(options).toHaveLength(3)
    expect(options.every(option => option.value.length < 32)).toBe(true)
    expect(JSON.stringify(tree).length).toBeLessThan(100000)
    await pane.select({ key: 'status', value: options[1]!.value })
    expect(await pane.find({ key: 'task-DEMO-1' })).toBeDefined()
    expect(await pane.find({ key: 'task-DEMO-2' })).toBeUndefined()
    await pane.press({ key: 'task-DEMO-1' })
    await pane.press({ key: 'attach' })
    const delivered = await submit()
    expect(delivered.drop).toBeUndefined()
    const record = JSON.parse(delivered.context![1]!.split('Untrusted task record (JSON):\n')[1]!)
    expect(record.status).toBe(longStatus)
    await pane.press({ key: 'back-to-list' })
    expect((await pane.find({ key: 'status' }))!.props.value).toBe(options[1]!.value)
    await pane.select({ key: 'status', value: options[2]!.value })
    expect(await pane.find({ key: 'task-DEMO-1' })).toBeUndefined()
    expect(await pane.find({ key: 'task-DEMO-2' })).toBeDefined()
    await pane.select({ key: 'status', value: options[0]!.value })
    expect(await pane.find({ key: 'task-DEMO-1' })).toBeDefined()
    expect(await pane.find({ key: 'task-DEMO-2' })).toBeDefined()
  })
}

test('empty and sentinel-like statuses do not break navigation', async ($, on) => {
  const { host, pane } = await setup($, on)
  host.rows = [{ ...ROWS[0]!, status: '' }, { ...ROWS[1]!, status: 'all' }]
  await pane.press({ key: 'refresh' })
  await pane.press({ key: 'view-navigator' })
  expect(await pane.find({ key: 'task-DEMO-1' })).toBeDefined()
  expect(await pane.find({ key: 'task-DEMO-2' })).toBeDefined()
  const options = (await pane.find({ key: 'status' }))!.props.options as { value: string }[]
  await pane.select({ key: 'status', value: options[1]!.value })
  expect(await pane.find({ key: 'task-DEMO-1' })).toBeDefined()
  expect(await pane.find({ key: 'task-DEMO-2' })).toBeUndefined()
  await pane.select({ key: 'status', value: options[2]!.value })
  expect(await pane.find({ key: 'task-DEMO-1' })).toBeUndefined()
  expect(await pane.find({ key: 'task-DEMO-2' })).toBeDefined()
  host.rows.reverse()
  await pane.press({ key: 'refresh' })
  expect(await pane.find({ key: 'task-DEMO-1' })).toBeUndefined()
  expect(await pane.find({ key: 'task-DEMO-2' })).toBeDefined()
  const reordered = (await pane.find({ key: 'status' }))!.props.options as { value: string }[]
  expect((await pane.find({ key: 'status' }))!.props.value).toBe(reordered[1]!.value)
  await pane.select({ key: 'status', value: reordered[0]!.value })
  expect(await pane.find({ key: 'task-DEMO-1' })).toBeDefined()
  expect(await pane.find({ key: 'task-DEMO-2' })).toBeDefined()
})

test('ordinary prompts discard cached tasks after a project change without reading the backlog', async ($, on) => {
  const { host, pane, footer, select, submit } = await setup($, on)
  await select()
  host.root = '/another-project'
  const reads = host.reads.length
  expect((await submit()).context).toEqual(['Other plugin context'])
  expect(host.reads.length).toBe(reads)
  expect(await recomposed(pane)).not.toMatch(/Criterion of DEMO-2/)
  expect(await footer.find({ type: 'Text', text: /DEMO-2/ })).toBeUndefined()
})

test('prepare again uses fresh details after a revision mismatch', async ($, on) => {
  const { host, pane, select, submit } = await setup($, on)
  await select()
  await pane.press({ key: 'attach' })
  host.changed = true
  expect((await submit()).drop).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Changed after preparation/ })).toBeDefined()
  await pane.press({ key: 'attach' })
  const result = await submit()
  expect(result.drop).toBeUndefined()
  expect(result.context?.[1]).toContain('Changed after preparation')
})

for (const after of ['refresh', 'close'] as const) {
  test(`refresh waiting for identity cannot outlive a later ${after}`, async ($, on) => {
    const { host, pane, footer, select } = await setup($, on)
    await select()
    host.holdIdentity = true
    const started = new Promise<void>(resolve => { host.identityStarted = resolve })
    const first = pane.press({ key: 'refresh' })
    await started
    if (after === 'refresh') await pane.press({ key: 'refresh' })
    else await footer.press({ key: 'backlog-toggle' })
    const reads = host.reads.length
    host.releaseIdentity?.()
    await first
    expect(host.reads.length).toBe(reads)
    if (after === 'refresh') expect(await recomposed(pane)).toMatch(/Criterion of DEMO-2/)
    else expect(host.panes).toEqual([])
  })
}

for (const changed of ['project', 'session'] as const) {
  test(`one refresh loads the new ${changed} without a second click`, async ($, on) => {
    const { host, pane, select } = await setup($, on)
    await select()
    if (changed === 'project') host.root = '/another-project'
    else {
      await $.session.end({ reason: 'clear', sessionId: host.sessionId, resume: { id: host.sessionId } })
      host.sessionId = 'session-2'
    }
    host.rows = [{ id: 'DEMO-3', title: 'New source task', status: 'To Do' }]
    const reads = host.reads.length
    await pane.press({ key: 'refresh' })
    expect(host.reads.length).toBe(reads + 1)
    await pane.press({ key: 'view-navigator' })
    expect(await pane.find({ key: 'task-DEMO-3' })).toBeDefined()
    expect(await pane.find({ key: 'task-DEMO-2' })).toBeUndefined()
    expect(await recomposed(pane)).not.toMatch(/Criterion of DEMO-2/)
    expect(await pane.find({ type: 'Text', text: `Source: ${host.root}` })).toBeDefined()
  })
}

test('an archived collision does not hide unambiguous tasks or allow ambiguous attachment', async ($, on) => {
  const { host, pane, select, submit } = await setup($, on)
  host.collision = true
  await pane.press({ key: 'refresh' })
  await pane.press({ key: 'view-navigator' })
  expect(await pane.find({ key: 'task-DEMO-2' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /DEMO-1.*ambigu|ambigu.*DEMO-1/i })).toBeDefined()
  await select('DEMO-2')
  await pane.press({ key: 'attach' })
  expect((await submit()).context?.[1]).toContain('DEMO-2')
  await select('DEMO-1')
  expect(await pane.find({ type: 'Text', text: /Ambiguous task ID DEMO-1/ })).toBeDefined()
  await pane.press({ key: 'attach' })
  expect((await submit()).context).toEqual(['Other plugin context'])
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`task detail replaces the list and back restores its page on ${surface}`, async ($, on) => {
    const { host, pane, footer, submit } = await setup($, on, surface)
    host.rows = Array.from({ length: 18 }, (_, i) => ({ id: `DEMO-${i + 1}`, title: `Result ${i + 1}`, status: i < 17 ? 'To Do' : 'Done' }))
    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'view-navigator' })
    await pane.input({ key: 'query', text: 'Result', kind: 'change' })
    await pane.select({ key: 'status', value: '0' })
    await pane.press({ key: 'page-next' })
    const previousRows = (await pane.findAll({ type: 'Button' })).filter(row => row.key?.startsWith('task-')).map(row => row.key)
    expect(previousRows).toHaveLength(8)
    await pane.press({ key: 'task-DEMO-9' })
    expect(await pane.find({ key: 'back-to-list' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Synthetic description' })).toBeDefined()
    expect(await pane.find({ key: 'query' })).toBeUndefined()
    expect(await pane.find({ key: 'status' })).toBeUndefined()
    expect(await pane.find({ key: 'page-next' })).toBeUndefined()
    expect((await pane.findAll({ type: 'Button' })).filter(row => row.key?.startsWith('task-'))).toHaveLength(0)
    await pane.press({ key: 'attach' })
    await footer.press({ key: 'backlog-toggle' })
    await footer.press({ key: 'backlog-toggle' })
    expect(await pane.find({ key: 'back-to-list' })).toBeDefined()
    const reads = host.reads.length
    await pane.press({ key: 'back-to-list' })
    expect(host.reads.length).toBe(reads)
    expect((await pane.find({ key: 'query' }))?.props.value).toBe('Result')
    expect((await pane.find({ key: 'status' }))?.props.value).toBe('0')
    expect((await pane.findAll({ type: 'Button' })).filter(row => row.key?.startsWith('task-')).map(row => row.key)).toEqual(previousRows)
    expect(await pane.find({ type: 'Text', text: 'Synthetic description' })).toBeUndefined()
    expect(await pane.find({ key: 'back-to-list' })).toBeUndefined()
    expect((await submit()).context?.[1]).toContain('DEMO-9')
  })
}

test('reopening after interrupted detail loading returns to a usable list', async ($, on) => {
  const { host, pane, footer } = await setup($, on)
  await pane.press({ key: 'view-navigator' })
  host.heldId = 'DEMO-1'
  const started = new Promise<void>(resolve => { host.onHeld = resolve })
  const pending = pane.press({ key: 'task-DEMO-1' })
  await started
  await footer.press({ key: 'backlog-toggle' })
  host.release?.()
  await pending
  host.heldId = ''
  const reads = host.reads.length
  await footer.press({ key: 'backlog-toggle' })
  expect(await pane.find({ key: 'task-DEMO-1' })).toBeDefined()
  expect(await pane.find({ key: 'query' })).toBeDefined()
  expect(host.reads.length).toBe(reads)
  await pane.press({ key: 'task-DEMO-1' })
  expect(await pane.find({ type: 'Text', text: 'Synthetic description' })).toBeDefined()
})

test('returning to the same loaded detail preserves its prepared attachment', async ($, on) => {
  const { host, pane, submit } = await setup($, on)
  await pane.press({ key: 'view-navigator' })
  await pane.press({ key: 'task-DEMO-2' })
  await pane.press({ key: 'attach' })
  await pane.press({ key: 'back-to-list' })
  const reads = host.reads.length
  await pane.press({ key: 'task-DEMO-2' })
  expect(await pane.find({ key: 'back-to-list' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Synthetic description' })).toBeDefined()
  expect(host.reads.length).toBe(reads)
  const result = await submit()
  expect(result.drop).toBeUndefined()
  expect(result.context?.[1]).toContain('DEMO-2')
})

test('back during loading stays on the list after the detail arrives', async ($, on) => {
  const { host, pane } = await setup($, on)
  await pane.press({ key: 'view-navigator' })
  host.heldId = 'DEMO-1'
  const started = new Promise<void>(resolve => { host.onHeld = resolve })
  const pending = pane.press({ key: 'task-DEMO-1' })
  await started
  expect(await pane.find({ type: 'Text', text: /Loading detail/ })).toBeDefined()
  expect(await pane.find({ key: 'query' })).toBeUndefined()
  await pane.press({ key: 'back-to-list' })
  host.release?.()
  await pending
  expect(await pane.find({ key: 'task-DEMO-2' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Synthetic description' })).toBeUndefined()
  expect(await pane.find({ key: 'back-to-list' })).toBeUndefined()
})

test('an ambiguous detail has a way back to the list', async ($, on) => {
  const { host, pane } = await setup($, on)
  host.collision = true
  await pane.press({ key: 'refresh' })
  await pane.press({ key: 'view-navigator' })
  await pane.press({ key: 'task-DEMO-1' })
  expect(await pane.find({ type: 'Text', text: /Ambiguous task ID DEMO-1/ })).toBeDefined()
  expect(await pane.find({ key: 'task-DEMO-2' })).toBeUndefined()
  await pane.press({ key: 'back-to-list' })
  expect(await pane.find({ key: 'task-DEMO-2' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Ambiguous task ID DEMO-1/ })).toBeUndefined()
})

test('review remains available from detail and navigation returns to the list', async ($, on) => {
  const { pane } = await setup($, on)
  await pane.press({ key: 'view-navigator' })
  await pane.press({ key: 'task-DEMO-2' })
  expect(await pane.find({ key: 'back-to-list' })).toBeDefined()
  await pane.press({ key: 'view-review' })
  expect(await recomposed(pane)).toMatch(/Criterion of DEMO-2/)
  await pane.press({ key: 'view-navigator' })
  expect(await pane.find({ key: 'task-DEMO-2' })).toBeDefined()
  expect(await pane.find({ key: 'back-to-list' })).toBeUndefined()
})

test('refresh restores the selected task detail and review tab', async ($, on) => {
  const { host, pane, select, submit } = await setup($, on)
  await select()
  await pane.press({ key: 'tab-dod' })
  host.changed = true
  await pane.press({ key: 'refresh' })
  expect(await recomposed(pane)).toMatch(/DoD of DEMO-2/)
  expect(await pane.find({ type: 'Text', text: /Changed after preparation/ })).toBeDefined()
  await pane.press({ key: 'attach' })
  expect((await submit()).context).toHaveLength(2)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`body colors preserve text, navigation and raw context on ${surface}`, async ($, on) => {
    const { host, pane, submit } = await setup($, on, surface)
    host.description = 'Fixed by REG-7, see docs/src/guide.md and https://e.com/a?q=1.\nNext line.'
    host.acText = 'Check https://e.com/ac in config.yml for REG-8.'
    host.dodText = 'Read https://e.com/dod in pom.xml for REG-9.'
    await pane.press({ key: 'view-navigator' })
    await pane.press({ key: 'task-DEMO-2' })
    const reads = host.reads.length
    const writes = host.writes.length
    const tree = await drawnTree(pane)
    expect(textBlocks(tree)).toContain(host.description)
    expect(spansOf(tree, 'magenta')).toEqual(['REG-7'])
    expect(spansOf(tree, 'yellow')).toEqual(['docs/src/guide.md'])
    expect(spansOf(tree, 'cyan')).toEqual(['https://e.com/a?q=1'])
    expect(host.reads.length).toBe(reads)
    expect(host.writes.length).toBe(writes)
    await pane.press({ key: 'view-review' })
    const ac = await drawnTree(pane)
    expect(textBlocks(ac)).toContain(`[ ] ${host.acText}`)
    expect(spansOf(ac, 'cyan')).toEqual(['https://e.com/ac'])
    expect(spansOf(ac, 'yellow')).toEqual(['config.yml'])
    expect(spansOf(ac, 'magenta')).toEqual(['REG-8'])
    await pane.press({ key: 'tab-dod' })
    const dod = await drawnTree(pane)
    expect(textBlocks(dod)).toContain(`[x] ${host.dodText}`)
    expect(spansOf(dod, 'cyan')).toEqual(['https://e.com/dod'])
    expect(spansOf(dod, 'yellow')).toEqual(['pom.xml'])
    expect(spansOf(dod, 'magenta')).toEqual(['REG-9'])
    await pane.press({ key: 'view-navigator' })
    const listTree = await drawnTree(pane)
    expect(spansOf(listTree, 'magenta')).toEqual(['DEMO-1', '* DEMO-2'])
    expect(textBlocks(listTree)).not.toContain(host.description)
    await pane.press({ key: 'task-DEMO-2' })
    expect(textBlocks(await drawnTree(pane))).toContain(host.description)
    expect(host.reads.length).toBe(reads)
    await pane.press({ key: 'attach' })
    const result = await submit()
    expect(result.drop).toBeUndefined()
    const record = JSON.parse(result.context![1]!.split('Untrusted task record (JSON):\n')[1]!)
    expect(record.description).toBe(host.description)
    expect(record.acceptanceCriteria).toEqual([{ text: host.acText, checked: false }])
    expect(record.definitionOfDone).toEqual([{ text: host.dodText, checked: true }])
  })

  test(`sanitization and dense body bounds remain intact on ${surface}`, async ($, on) => {
    const { host, pane, submit } = await setup($, on, surface)
    host.description = 'Cached \x1b[31mred\x1b[0m\x00 REG-3\nnext'
    await pane.press({ key: 'view-navigator' })
    await pane.press({ key: 'task-DEMO-2' })
    expect(textBlocks(await drawnTree(pane))).toContain('Cached red REG-3\nnext')
    expect(spansOf(await drawnTree(pane), 'magenta')).toEqual(['REG-3'])
    await pane.press({ key: 'attach' })
    const delivered = await submit()
    const record = JSON.parse(delivered.context![1]!.split('Untrusted task record (JSON):\n')[1]!)
    expect(record.description).toBe(host.description)
    host.description = 'REG-1 '.repeat(600)
    await pane.press({ key: 'refresh' })
    let tree = await drawnTree(pane)
    expect(textBlocks(tree)).toContain(`${host.description.slice(0, 2400)}… [text truncated]`)
    expect(spansOf(tree, 'magenta')).toHaveLength(128)
    expect(JSON.stringify(tree).length).toBeLessThan(100000)
    expect(depthOf(tree)).toBeLessThanOrEqual(32)
    expect(nodeCount(tree)).toBeLessThan(20000)
    host.acText = 'REG-2 '.repeat(1100)
    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'view-review' })
    tree = await drawnTree(pane)
    expect(textBlocks(tree)).toContain(`${`[ ] ${host.acText}`.slice(0, 6000)}… [text truncated]`)
    expect(spansOf(tree, 'magenta')).toHaveLength(128)
    expect(JSON.stringify(tree).length).toBeLessThan(100000)
    expect(depthOf(tree)).toBeLessThanOrEqual(32)
    expect(nodeCount(tree)).toBeLessThan(20000)
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`row fragments recompose the exact label without body tokenization on ${surface}`, async ($, on) => {
    const { host, pane } = await setup($, on, surface)
    host.rows = [
      { id: 'DEMO-1', title: 'See docs/src/guide.md, REG-4, https://e.com/x \x1b[31mred\x1b[0m\nnext\tline', status: 'Waiting Review' },
      { id: 'DEMO-2', title: 'L'.repeat(120), status: 'S'.repeat(60) },
    ]
    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'view-navigator' })
    const tree = await drawnTree(pane)
    const rows = taskButtons(tree)
    expect(rows.map(row => row.props?.key)).toEqual(['task-DEMO-1', 'task-DEMO-2'])
    const expectedTitles = ['See docs/src/guide.md, REG-4, https://e.com/x red next line', `${'L'.repeat(80)}… [text truncated]`]
    const expectedStatuses = ['Waiting Review', `${'S'.repeat(40)}… [text truncated]`]
    for (const [index, row] of rows.entries()) {
      expect(row.props?.label).toBe(`DEMO-${index + 1} · ${expectedTitles[index]} (${expectedStatuses[index]})`)
      expect(recompose(row)).toBe(row.props?.label)
      expect(String(row.props?.label)).not.toMatch(/[\x1b\x00-\x1f]/)
    }
    expect(spansOf(tree, 'magenta')).toEqual(['DEMO-1', 'DEMO-2'])
    expect(spansOf(tree, 'yellow')).toEqual([])
    expect(spansOf(tree, 'cyan')).toEqual(['Waiting Review'])
  })

  test(`saved status colors match the full value only on ${surface}`, async ($, on) => {
    const { host, pane } = await setup($, on, surface)
    host.rows = [
      { id: 'DEMO-1', title: 'One', status: 'To Do' },
      { id: 'DEMO-2', title: 'Two', status: 'In Progress' },
      { id: 'DEMO-3', title: 'Three', status: 'Waiting Review' },
      { id: 'DEMO-4', title: 'Four', status: 'Done' },
      { id: 'DEMO-5', title: 'Five', status: 'Custom STATus' },
      { id: 'DEMO-6', title: 'Six', status: '' },
      { id: 'DEMO-7', title: 'Seven', status: 'toString' },
      { id: 'DEMO-8', title: 'Eight', status: 'constructor' },
    ]
    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'view-navigator' })
    const rows = taskButtons(await drawnTree(pane))
    expect(rows).toHaveLength(8)
    const expected: [string, string | undefined, boolean | undefined][] = [
      ['To Do', undefined, true],
      ['In Progress', 'yellow', undefined],
      ['Waiting Review', 'cyan', undefined],
      ['Done', 'green', undefined],
      ['Custom STATus', undefined, undefined],
      ['', undefined, undefined],
      ['toString', undefined, undefined],
      ['constructor', undefined, undefined],
    ]
    for (const [index, [status, color, dim]] of expected.entries()) {
      const row = rows[index]!
      const parts = textChildren(row)
      expect(parts).toHaveLength(3)
      expect(recompose(parts[2]!)).toBe(status)
      expect(parts[2]!.props?.color).toBe(color)
      expect(parts[2]!.props?.dimColor).toBe(dim)
      expect(recompose(row)).toBe(row.props?.label)
    }
  })

  test(`selection keeps the star and the heavier title on the chosen row only on ${surface}`, async ($, on) => {
    const { pane } = await setup($, on, surface)
    await pane.press({ key: 'view-navigator' })
    await pane.press({ key: 'task-DEMO-2' })
    await pane.press({ key: 'back-to-list' })
    const rows = taskButtons(await drawnTree(pane))
    const [first, second] = rows
    expect(first?.props?.key).toBe('task-DEMO-1')
    expect(second?.props?.key).toBe('task-DEMO-2')
    expect(first?.props?.label).toBe('DEMO-1 · First synthetic task (Waiting Review)')
    expect(second?.props?.label).toBe('* DEMO-2 · Second synthetic task (To Do)')
    expect(textChildren(first!)).toHaveLength(3)
    expect(textChildren(second!)).toHaveLength(3)
    const [firstId, firstTitle] = textChildren(first!)
    const [secondId, secondTitle] = textChildren(second!)
    expect(recompose(firstId!)).toBe('DEMO-1')
    expect(firstId!.props?.color).toBe('magenta')
    expect(firstTitle!.props?.weight).toBeUndefined()
    expect(recompose(secondId!)).toBe('* DEMO-2')
    expect(secondId!.props?.color).toBe('magenta')
    expect(secondTitle!.props?.weight).toBe('semibold')
  })

  test(`three separated groups frame the content and keep filters above context on ${surface}`, async ($, on) => {
    const { pane } = await setup($, on, surface)
    await pane.press({ key: 'view-navigator' })
    const root = await drawnTree(pane) as ElementNode
    expect(root.type).toBe('Box')
    expect(root.props?.flexDirection).toBe('column')
    expect(root.props?.gap).toBe(1)
    const groups = (root.children ?? []).filter((child): child is ElementNode => typeof child !== 'string' && child.type === 'Box')
    expect(groups).toHaveLength(3)
    const frames = boxesOf(root).filter(box => box.props?.borderStyle === 'single')
    expect(frames).toHaveLength(1)
    expect(frames[0]!.props?.borderDimColor).toBe(true)
    expect(frames[0]!.props?.paddingX).toBe(1)
    expect(textBlocks(frames[0]!)).toContain('Tasks · saved statuses')
    expect(taskButtons(frames[0]!)).toHaveLength(2)
    expect(taskButtons(groups[0]!)).toHaveLength(0)
    const order = keyOrder(root)
    expect(order.indexOf('query')).toBeLessThan(order.indexOf('task-DEMO-1'))
    expect(order.indexOf('status')).toBeLessThan(order.indexOf('task-DEMO-1'))
    expect(order.indexOf('task-DEMO-2')).toBeLessThan(order.indexOf('context'))
    expect(order.indexOf('context')).toBeLessThan(order.indexOf('attach'))
    const navRow = boxesOf(root).find(box => (box.children ?? []).some(child => typeof child !== 'string' && child.props?.key === 'view-navigator'))
    expect(navRow?.props?.columnGap).toBe(1)
    expect(navRow?.props?.flexWrap).toBe('wrap')
    const actionRow = boxesOf(root).find(box => (box.children ?? []).some(child => typeof child !== 'string' && child.props?.key === 'attach'))
    expect(actionRow?.props?.columnGap).toBe(1)
    expect(actionRow?.props?.flexWrap).toBe('wrap')
    await pane.press({ key: 'task-DEMO-2' })
    expect(textBlocks((await framedContent(pane))!)).toContain('Description')
    await pane.press({ key: 'view-review' })
    expect(textBlocks((await framedContent(pane))!)).toContain('Review')
  })

  test(`one press reads the task once and back keeps page, filters and attachment on ${surface}`, async ($, on) => {
    const { host, pane, submit } = await setup($, on, surface)
    host.rows = Array.from({ length: 18 }, (_, i) => ({ id: `DEMO-${i + 1}`, title: `Result ${i + 1}`, status: i < 17 ? 'To Do' : 'Done' }))
    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'view-navigator' })
    await pane.input({ key: 'query', text: 'Result', kind: 'change' })
    await pane.select({ key: 'status', value: '0' })
    await pane.press({ key: 'page-next' })
    const pageRows = taskButtons(await drawnTree(pane)).map(row => row.props?.key)
    expect(pageRows).toHaveLength(8)
    const reads = host.reads.length
    await pane.press({ key: 'task-DEMO-9' })
    expect(host.reads.length).toBe(reads + 1)
    expect(host.reads[host.reads.length - 1]).toContain('DEMO-9')
    await pane.press({ key: 'attach' })
    const prepared = host.reads.length
    await pane.press({ key: 'back-to-list' })
    expect(host.reads.length).toBe(prepared)
    const frame = await framedContent(pane)
    expect(frame).toBeDefined()
    expect(taskButtons(frame!).map(row => row.props?.key)).toEqual(pageRows)
    expect((await pane.find({ key: 'query' }))?.props.value).toBe('Result')
    expect((await pane.find({ key: 'status' }))?.props.value).toBe('0')
    const result = await submit()
    expect(result.drop).toBeUndefined()
    expect(result.context?.[1]).toContain('DEMO-9')
  })
}

test('mobile keeps the fallback notice inside the separated groups', async ($, on) => {
  const { pane } = await setup($, on, 'mobile')
  await pane.press({ key: 'view-navigator' })
  const root = await drawnTree(pane) as ElementNode
  expect(root.props?.gap).toBe(1)
  expect((root.children ?? []).filter((child): child is ElementNode => typeof child !== 'string' && child.type === 'Box')).toHaveLength(3)
  expect(await pane.find({ type: 'Text', text: 'Search and selectors are not available on this surface.' })).toBeDefined()
  const order = keyOrder(root)
  expect(order).not.toContain('query')
  expect(order).not.toContain('status')
  expect(order).not.toContain('context')
  expect(order).toContain('task-DEMO-1')
  await pane.press({ key: 'task-DEMO-2' })
  expect(await pane.find({ type: 'Text', text: 'Synthetic description' })).toBeDefined()
})

const FOOTER_NOTICE = 'Saved data only; no writes. Commands and text starting with \'/\' do not consume the attachment.'
const REMOVED_HEADINGS = ['Contesto per il prossimo prompt', 'Context for the next prompt', 'Attach task to next message']
const optionLabels = (element: { props?: { options?: unknown } } | undefined): string[] =>
  ((element?.props?.options ?? []) as { label: string }[]).map(option => option.label)
const buttonLabel = async (pane: { find(query: { key: string }): Promise<unknown> }, key: string): Promise<string | undefined> =>
  ((await pane.find({ key })) as { props?: { label?: unknown } } | undefined)?.props?.label as string | undefined

for (const surface of ['terminal', 'desktop'] as const) {
  test(`controls and selectors carry the English labels and options on ${surface}`, async ($, on) => {
    const { host, pane } = await setup($, on, surface)
    host.rows = [{ id: 'DEMO-1', title: 'First synthetic task', status: '' }, { ...ROWS[1]! }]
    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'view-navigator' })
    expect(await buttonLabel(pane, 'view-navigator')).toBe('Browse')
    expect(await buttonLabel(pane, 'view-review')).toBe('Review')
    expect(await buttonLabel(pane, 'refresh')).toBe('Refresh')
    expect(await buttonLabel(pane, 'backlog-close')).toBe('Close')
    expect(await buttonLabel(pane, 'page-prev')).toBe('Previous')
    expect(await buttonLabel(pane, 'page-next')).toBe('Next')
    expect(await buttonLabel(pane, 'query')).toBe('Search')
    const status = await pane.find({ key: 'status' })
    expect(status?.props?.label).toBe('Status')
    expect(optionLabels(status)).toEqual(['All', 'No status', 'To Do'])
    expect((await pane.find({ key: 'context' }))?.props?.label).toBe('Context')
    expect(optionLabels(await pane.find({ key: 'context' }))).toEqual(['Brief', 'Criteria', 'Full'])
    expect(await pane.find({ type: 'Text', text: 'Tasks · saved statuses' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^1-2 of 2$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'No tasks' })).toBeUndefined()
  })

  test(`the context heading is removed without a replacement on ${surface}`, async ($, on) => {
    const { pane } = await setup($, on, surface)
    await pane.press({ key: 'view-navigator' })
    for (const heading of REMOVED_HEADINGS) {
      expect(await pane.find({ type: 'Text', text: heading })).toBeUndefined()
    }
    const root = await drawnTree(pane) as ElementNode
    expect(textBlocks(root).some(text => REMOVED_HEADINGS.includes(text.trim()))).toBe(false)
    const actions = boxesOf(root).find(box => (box.children ?? []).some(child => typeof child !== 'string' && child.type === 'Select' && child.props?.key === 'context'))
    expect(actions).toBeDefined()
    const directChildren = (actions!.children ?? []).filter((child): child is ElementNode => typeof child !== 'string')
    expect(directChildren[0]?.props?.key).toBe('context')
    expect(directChildren.filter(child => child.type === 'Text').map(recompose)).toEqual([FOOTER_NOTICE])
    expect(await buttonLabel(pane, 'attach')).toBe('Attach to next message')
    expect(await buttonLabel(pane, 'prepare-review')).toBe('Prepare review')
    expect(await buttonLabel(pane, 'remove')).toBe('Remove')
    await pane.press({ key: 'task-DEMO-2' })
    expect(textBlocks((await framedContent(pane))!)).toContain('Description')
    expect(await buttonLabel(pane, 'back-to-list')).toBe('Back to list')
    await pane.press({ key: 'view-review' })
    expect(textBlocks((await framedContent(pane))!)).toContain('Review')
  })

  test(`an empty list shows the English empty text on ${surface}`, async ($, on) => {
    const { host, pane } = await setup($, on, surface)
    host.rows = []
    await pane.press({ key: 'refresh' })
    await pane.press({ key: 'view-navigator' })
    expect(await pane.find({ type: 'Text', text: 'No tasks' })).toBeDefined()
  })
}

test('raw Italian task data passes through display and attachment untranslated', async ($, on) => {
  const { host, pane, submit } = await setup($, on)
  host.rows = [{ id: 'DEMO-2', title: 'Aggiornare la guida utente', status: 'In Corso' }]
  host.description = 'Rivedere il capitolo due prima del rilascio.'
  host.acText = 'Verificare la configurazione di produzione'
  host.dodText = 'Completare il rilascio nella roadmap'
  await pane.press({ key: 'refresh' })
  await pane.press({ key: 'view-navigator' })
  expect(optionLabels(await pane.find({ key: 'status' }))).toEqual(['All', 'In Corso'])
  expect(taskButtons(await drawnTree(pane)).map(row => row.props?.label)).toEqual(['DEMO-2 · Aggiornare la guida utente (In Corso)'])
  await pane.press({ key: 'task-DEMO-2' })
  const detail = await drawnTree(pane)
  expect(textBlocks(detail)).toContain(host.description)
  expect(textBlocks(detail)).toContain('Saved status: In Corso')
  await pane.press({ key: 'view-review' })
  expect(textBlocks(await drawnTree(pane))).toContain(`[ ] ${host.acText}`)
  await pane.press({ key: 'tab-dod' })
  expect(textBlocks(await drawnTree(pane))).toContain(`[x] ${host.dodText}`)
  await pane.press({ key: 'attach' })
  const result = await submit()
  expect(result.drop).toBeUndefined()
  const record = JSON.parse(result.context![1]!.split('Untrusted task record (JSON):\n')[1]!)
  expect(record.title).toBe('Aggiornare la guida utente')
  expect(record.status).toBe('In Corso')
  expect(record.description).toBe(host.description)
  expect(record.acceptanceCriteria).toEqual([{ text: host.acText, checked: false }])
  expect(record.definitionOfDone).toEqual([{ text: host.dodText, checked: true }])
})

test('plugin-owned refusal and failure texts are in English', async ($, on) => {
  const { host, pane, select, submit } = await setup($, on)
  await select()
  await pane.press({ key: 'attach' })
  host.changed = true
  const refused = await submit()
  expect(refused.drop).toBe('Backlog: The task changed after preparation. The detail is up to date: review it and prepare again. '
    + 'Prompt stopped; remove or prepare the attachment again.')
  expect(await pane.find({ type: 'Text', text: /^Attachment unavailable: The task changed after preparation/ })).toBeDefined()
  await pane.press({ key: 'remove' })
  expect((await submit('Without attachment')).context).toEqual(['Other plugin context'])
})
