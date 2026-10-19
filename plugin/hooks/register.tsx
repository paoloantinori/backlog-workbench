import { atom, read, update } from 'claude-code'
import type { ButtonProps, BoxProps, ElementConstructor, EngineInterface, Register, TextProps } from 'claude-code'
import { contextFor, taskRevision, readTask, readTasks, resolveSource } from '../backlog'
import type { AppState } from '../state'
import { taskSegments } from '../task-text'
import type { SegmentKind } from '../task-text'

const PANE = 'backlog'
const PAGE = 8
const APP = { plugin: 'backlog-workbench', key: 'app' } as const
const INITIAL: AppState = {
  sessionKey: null, listGen: 0, detailGen: 0, source: null, rows: [], conflicts: [],
  listError: null, pendingList: false, pendingDetail: false, selectedId: null,
  detail: null, detailError: null, query: '', statusFilter: null, offset: 0,
  view: 'review', navigatorPage: 'list', tab: 'ac', contextMode: 'full', tokenSeq: 0, attachment: { kind: 'none' },
}
const app = atom(APP, INITIAL)
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const clean = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
const clipped = (text: string, cap = 300) => {
  const value = clean(text)
  return value.length <= cap ? value : `${value.slice(0, cap)}… [text truncated]`
}
const oneLine = (text: string, cap = 140) => clipped(text.replace(/\s+/g, ' '), cap)
const sessionKey = async ($: EngineInterface) => JSON.stringify([await $.session.id(), await $.session.root()])
const invalidated = (state: AppState, reason: string): AppState['attachment'] =>
  state.attachment.kind === 'none' ? state.attachment : { kind: 'failed', reason }

async function ensureSession($: EngineInterface): Promise<AppState> {
  const key = await sessionKey($)
  const current = await read($, app)
  if (current.sessionKey === key) return current
  return update<AppState>($, app, state => state.sessionKey === key ? state : {
    ...INITIAL, sessionKey: key, listGen: state.listGen + 1, detailGen: state.detailGen + 1,
    tokenSeq: state.tokenSeq, attachment: invalidated(state, 'Session or project changed. Prepare the context again.'),
  })
}

async function sessionMoved($: EngineInterface, key: string | null): Promise<boolean> {
  if (await sessionKey($) === key) return false
  await ensureSession($)
  return true
}

async function change($: EngineInterface, fn: (state: AppState) => AppState, affectsAttachment = false) {
  const current = await ensureSession($)
  return update<AppState>($, app, state => {
    if (state.sessionKey !== current.sessionKey || (affectsAttachment && state.attachment.kind === 'validating')) return state
    const next = fn(state)
    return affectsAttachment ? { ...next, attachment: invalidated(state, 'Task or context changed. Prepare again.') } : next
  })
}

async function refreshList($: EngineInterface) {
  const started = await update<AppState>($, app, state =>
    state.attachment.kind === 'validating' ? state : {
      ...state, listGen: state.listGen + 1, detailGen: state.detailGen + 1,
      pendingList: true, pendingDetail: false, rows: [], conflicts: [], detail: null,
      listError: null, detailError: null, source: null, attachment: invalidated(state, 'Data refreshed. Prepare again.'),
    })
  if (!started.pendingList || started.attachment.kind === 'validating') return
  let readKey = started.sessionKey
  const matches = (state: AppState) => state.sessionKey === readKey && state.listGen === started.listGen
  try {
    const key = await sessionKey($)
    if (key !== readKey) {
      const rebased = await update<AppState>($, app, state => !matches(state) || !state.pendingList ? state : {
        ...INITIAL, sessionKey: key, listGen: state.listGen, detailGen: state.detailGen,
        tokenSeq: state.tokenSeq, attachment: state.attachment, pendingList: true,
      })
      if (rebased.sessionKey !== key || rebased.listGen !== started.listGen || !rebased.pendingList) return
      readKey = key
    }
    if (!matches(await read($, app))) return
    const source = await resolveSource($)
    if (await sessionMoved($, readKey)) return
    const beforeRead = await read($, app)
    if (!matches(beforeRead) || !beforeRead.pendingList) return
    const { tasks: rows, conflicts } = await readTasks($, source)
    if (await sessionMoved($, readKey)) return
    const refreshed = await update<AppState>($, app, state => {
      if (!matches(state)) return state
      const selectedId = rows.some(row => row.id === state.selectedId) ? state.selectedId : null
      return { ...state, source, rows, conflicts, pendingList: false, selectedId, pendingDetail: selectedId !== null }
    })
    if (matches(refreshed)) await loadSelected($, refreshed)
  } catch (error) {
    if (await sessionMoved($, readKey)) return
    await update<AppState>($, app, state => !matches(state) ? state : {
      ...state, source: null, listError: errorText(error), pendingList: false,
    })
  }
}

async function selectTask($: EngineInterface, id: string) {
  const started = await update<AppState>($, app, state =>
    !state.source || state.attachment.kind === 'validating' ? state
      : state.selectedId === id && state.detail?.id === id && !state.pendingDetail && !state.detailError
        ? { ...state, navigatorPage: 'detail' }
        : {
          ...state, detailGen: state.detailGen + 1, selectedId: id, navigatorPage: 'detail', detail: null,
          pendingDetail: true, detailError: null, attachment: invalidated(state, 'Selection changed. Prepare again.'),
        })
  if (started.attachment.kind === 'validating') return
  if (started.detail && await sessionMoved($, started.sessionKey)) return
  if (started.navigatorPage === 'detail') {
    $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {})
    $.ui.focus({ requestId: PANE, key: 'back-to-list' }).catch(() => {})
  }
  await loadSelected($, started)
}

async function loadSelected($: EngineInterface, started: AppState) {
  if (!started.source || !started.selectedId || !started.pendingDetail) return
  const id = started.selectedId
  const matches = (state: AppState) => state.sessionKey === started.sessionKey && state.detailGen === started.detailGen
    && state.source?.root === started.source?.root && state.selectedId === id && state.pendingDetail
  try {
    if (await sessionMoved($, started.sessionKey)) return
    if (!matches(await read($, app))) return
    const detail = await readTask($, started.source, id)
    if (await sessionMoved($, started.sessionKey)) return
    await update<AppState>($, app, state => !matches(state) ? state : { ...state, detail, pendingDetail: false })
  } catch (error) {
    if (await sessionMoved($, started.sessionKey)) return
    await update<AppState>($, app, state => !matches(state) ? state : { ...state, detailError: errorText(error), pendingDetail: false })
  }
}

async function invalidateReads($: EngineInterface) {
  await update<AppState>($, app, state => ({ ...state,
    listGen: state.listGen + (state.pendingList ? 1 : 0),
    detailGen: state.detailGen + (state.pendingDetail ? 1 : 0),
    navigatorPage: state.pendingDetail ? 'list' : state.navigatorPage,
    pendingList: false, pendingDetail: false,
  }))
}

async function showList($: EngineInterface) {
  const state = await change($, s => ({ ...s, view: 'navigator', navigatorPage: 'list' }))
  $.ui.scroll({ in: PANE, to: 'start' }).catch(() => {})
  if (state.selectedId) $.ui.focus({ requestId: PANE, key: `task-${state.selectedId}` }).catch(() => {})
}

async function closePane($: EngineInterface) {
  await invalidateReads($)
  await $.ui.close({ id: PANE })
}

async function toggle($: EngineInterface) {
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) { await closePane($); return }
  const opened = await $.ui.open({ id: PANE, title: 'Backlog' })
  if (!opened.isPlaced) { $.ui.toast(`Pane not visible: ${opened.reason}`); return }
  const state = await ensureSession($)
  if (!state.source && !state.pendingList) await refreshList($)
}

async function prepare($: EngineInterface, review: boolean) {
  const current = await ensureSession($)
  await update<AppState>($, app, state => {
    if (state.sessionKey !== current.sessionKey || !state.source || !state.detail || state.pendingDetail
      || state.detail.id !== state.selectedId || state.attachment.kind === 'validating') return state
    try {
      contextFor(state.detail, state.source, state.contextMode, review)
    } catch (error) {
      return { ...state, attachment: { kind: 'failed', reason: errorText(error) } }
    }
    return { ...state, tokenSeq: state.tokenSeq + 1, attachment: {
      kind: 'prepared', token: state.tokenSeq + 1, taskId: state.detail.id, mode: state.contextMode,
      review, root: state.source.root, gen: state.detailGen, taskRevision: taskRevision(state.detail),
    } }
  })
}

async function fail($: EngineInterface, token: number, reason: string) {
  await update<AppState>($, app, state =>
    (state.attachment.kind === 'prepared' || state.attachment.kind === 'validating') && state.attachment.token === token
      ? { ...state, attachment: { kind: 'failed', reason } } : state)
}

async function reserve($: EngineInterface, token: number) {
  const held = await $.state.get(APP)
  if (held.value?.attachment.kind !== 'prepared' || held.value.attachment.token !== token) return false
  return (await $.state.set(APP, { ...held.value, attachment: { ...held.value.attachment, kind: 'validating' } }, { ifVersion: held.version })).isSet
}

type Chrome = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
}

const SEGMENT_COLORS: Record<Exclude<SegmentKind, 'plain'>, string> = { link: 'cyan', file: 'yellow', task: 'magenta' }

const STATUS_STYLE: ReadonlyMap<string, Pick<TextProps, 'color' | 'dimColor'>> = new Map([
  ['To Do', { dimColor: true }],
  ['In Progress', { color: 'yellow' }],
  ['Waiting Review', { color: 'cyan' }],
  ['Done', { color: 'green' }],
])

function bodyText(text: string, { Text }: Chrome) {
  return <Text>{taskSegments(text).map(segment => segment.kind === 'plain'
    ? segment.text
    : <Text color={SEGMENT_COLORS[segment.kind]}>{segment.text}</Text>)}</Text>
}

function rowsBlock($: EngineInterface, { Box, Text, Button }: Chrome, state: AppState) {
  const query = state.query.trim().toLowerCase()
  const rows = state.rows.filter(row => (state.statusFilter === null || state.statusFilter === row.status)
    && (!query || `${row.id} ${row.title}`.toLowerCase().includes(query)))
  const last = Math.max(0, Math.ceil(rows.length / PAGE) - 1) * PAGE
  const offset = Math.min(state.offset, last)
  return <Box flexDirection="column">
    {rows.slice(offset, offset + PAGE).map(row => {
      const selected = state.selectedId === row.id
      const idText = `${selected ? '* ' : ''}${row.id}`
      const titleText = oneLine(row.title, 80)
      const statusText = oneLine(row.status, 40)
      return <Button key={`task-${row.id}`} label={`${idText} · ${titleText} (${statusText})`} onPress={() => selectTask($, row.id)}>
        <Text color="magenta">{idText}</Text>{' · '}<Text weight={selected ? 'semibold' : undefined}>{titleText}</Text>{' ('}<Text {...STATUS_STYLE.get(row.status) ?? {}}>{statusText}</Text>{')'}
      </Button>
    })}
    <Box columnGap={1} flexWrap="wrap">
      <Button key="page-prev" label="Previous" onPress={() => change($, s => ({ ...s, offset: Math.max(0, offset - PAGE) }))} />
      <Button key="page-next" label="Next" onPress={() => change($, s => ({ ...s, offset: Math.min(last, offset + PAGE) }))} />
      <Text dimColor>{rows.length ? `${offset + 1}-${Math.min(rows.length, offset + PAGE)} of ${rows.length}` : 'No tasks'}</Text>
    </Box>
  </Box>
}

function detailBlock($: EngineInterface, chrome: Chrome, state: AppState) {
  const { Box, Text, Button } = chrome
  if (state.pendingDetail) return <Text>Loading detail…</Text>
  if (state.detailError) return <Text>{clipped(state.detailError, 4000)}</Text>
  const task = state.detail
  if (!task) return <Text>Select a task in Browse (b).</Text>
  return <Box flexDirection="column" gap={1}>
    <Box flexDirection="column">
      <Text weight="semibold">{task.id} · {oneLine(task.title)}</Text>
      <Text dimColor>Saved status: {oneLine(task.status)}</Text>
    </Box>
    {state.view === 'navigator' ? bodyText(clipped(task.description, 2400), chrome) : <Box flexDirection="column">
      <Text dimColor>Saved checklists, not proof of current execution.</Text>
      <Box columnGap={1} flexWrap="wrap">
        <Button key="tab-ac" label="Criteria" onPress={() => change($, s => ({ ...s, tab: 'ac' }))} />
        <Button key="tab-dod" label="DoD" onPress={() => change($, s => ({ ...s, tab: 'dod' }))} />
      </Box>
      {bodyText(clipped((state.tab === 'ac' ? task.ac : task.dod).map(item => `${item.checked ? '[x]' : '[ ]'} ${item.text}`).join('\n') || 'No entries recorded.', 6000), chrome)}
    </Box>}
  </Box>
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'backlog', description: 'Show or hide the Backlog pane' })
    const current = await ensureSession($)
    await update<AppState>($, app, state => ({ ...state, listGen: state.listGen + 1, detailGen: state.detailGen + 1,
      pendingList: false, pendingDetail: false, rows: [], conflicts: [], source: null, detail: null,
      attachment: invalidated(current, 'Plugin reloaded. Prepare the context again.'),
    }))
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    await update<AppState>($, app, state => ({ ...INITIAL, listGen: state.listGen + 1, detailGen: state.detailGen + 1, tokenSeq: state.tokenSeq }))
    return next(e)
  })
  on('command.run', { command: 'backlog' }, async $ => { await toggle($); return { text: 'Backlog pane command executed.' } })
  on('ui.close', { id: PANE }, async ($, e, next) => {
    await invalidateReads($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const eligible = (e.origin.kind === 'composer' || e.origin.kind === 'bridge') && !e.command && !e.isMeta && !/^\s*\//.test(e.text)
    if (!eligible) return next(e)
    const state = await ensureSession($)
    if (state.attachment.kind === 'failed') return { drop: `Backlog: ${clipped(state.attachment.reason)} Remove the attachment or prepare it again.` }
    if (state.attachment.kind === 'validating') return { drop: 'Backlog: attachment validation in progress. Wait and submit the message again.' }
    if (state.attachment.kind === 'none') return next(e)
    const att = state.attachment
    if (!await reserve($, att.token)) return { drop: 'Backlog: preparation changed. Check the pane before submitting the message again.' }
    let submitted = false
    try {
      const source = await resolveSource($)
      if (source.root !== att.root || source.sessionId !== state.source?.sessionId) throw new Error('Source or session changed.')
      const task = await readTask($, source, att.taskId, 3000)
      const key = await sessionKey($)
      const latest = await read($, app)
      if (key !== state.sessionKey || latest.sessionKey !== key || latest.detailGen !== att.gen || latest.selectedId !== att.taskId
        || latest.source?.root !== att.root || latest.attachment.kind !== 'validating' || latest.attachment.token !== att.token) {
        throw new Error('Session, source, or selection changed during validation.')
      }
      if (taskRevision(task) !== att.taskRevision) {
        await update<AppState>($, app, current => current.sessionKey === key && current.detailGen === att.gen
          && current.selectedId === att.taskId && current.attachment.kind === 'validating' && current.attachment.token === att.token
          ? { ...current, detail: task, rows: current.rows.map(row => row.id === task.id
            ? { id: task.id, title: task.title, status: task.status } : row) } : current)
        throw new Error('The task changed after preparation. The detail is up to date: review it and prepare again.')
      }
      const text = contextFor(task, source, att.mode, att.review)
      if (text.length + (e.context ?? []).reduce((sum, block) => sum + block.length, 0) > 200000) throw new Error('The overall context exceeds the prompt limit.')
      submitted = true
      const result = await next({ ...e, context: [...(e.context ?? []), text] })
      if (result.drop !== undefined) { await fail($, att.token, `Delivery refused: ${result.drop}`); return result }
      await update<AppState>($, app, s => s.attachment.kind === 'validating' && s.attachment.token === att.token ? { ...s, attachment: { kind: 'none' } } : s)
      return result
    } catch (error) {
      await fail($, att.token, errorText(error))
      if (submitted) throw error
      return { drop: `Backlog: ${clipped(errorText(error))} Prompt stopped; remove or prepare the attachment again.` }
    }
  }).catch(async ($, e, next) => {
    try { await update<AppState>($, app, state => state.attachment.kind === 'validating' ? { ...state, attachment: { kind: 'failed', reason: 'Validation interrupted by the plugin.' } } : state) } catch {}
    return next.called ? next(e) : { drop: 'Backlog: attachment not validated; prompt stopped.' }
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const state = await read($, app)
    return <Box flexDirection="row" columnGap={1}>
      {await next(e)}
      <Box><Button key="backlog-toggle" label="Backlog" onPress={() => toggle($)} />
        <Text>{state.selectedId ? ` ${state.selectedId}` : ''}{state.attachment.kind === 'none' ? '' : ` · attachment ${state.attachment.kind}`}</Text>
      </Box>
    </Box>
  })
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const state = await read($, app)
    const c: Chrome = $.ui.resolve(e)
    const { Box, Text, Button } = c
    const busy = state.attachment.kind === 'validating'
    const onDetail = state.view === 'navigator' && state.navigatorPage === 'detail'
    const onList = state.view === 'navigator' && !onDetail
    const mobile = e.surface === 'mobile'
    const listFilters = mobile ? <Text>Search and selectors are not available on this surface.</Text> : onList ? (() => {
      const { Input, Select } = $.ui.resolve(e)
      const statuses = Array.from(new Set(state.rows.map(row => row.status)))
      return <Box flexDirection="column">
        <Input key="query" label="Search" value={state.query} onInput={value => change($, s => ({ ...s, query: value, offset: 0 }))} onSubmit={value => change($, s => ({ ...s, query: value, offset: 0 }))} />
        <Select key="status" label="Status" value={state.statusFilter === null ? 'all' : String(statuses.indexOf(state.statusFilter))} options={[{ value: 'all', label: 'All' }, ...statuses.map((status, index) => ({ value: String(index), label: oneLine(status, 60) || 'No status' }))]} onSelect={value => change($, s => ({ ...s, statusFilter: s.rows.find(row => row.status === statuses[Number(value)])?.status ?? null, offset: 0 }))} />
      </Box>
    })() : null
    const contextSelector = mobile ? null : (() => {
      const { Select } = $.ui.resolve(e)
      return <Select key="context" label="Context" value={state.contextMode} options={[{ value: 'short', label: 'Brief' }, { value: 'criteria', label: 'Criteria' }, { value: 'full', label: 'Full' }]} onSelect={value => change($, s => ({ ...s, contextMode: value === 'short' || value === 'criteria' ? value : 'full' }), true)} />
    })()
    return <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box columnGap={1} flexWrap="wrap">
          <Button key="view-navigator" label="Browse" hotkey="b" dimColor={state.view !== 'navigator'} onPress={() => showList($)} />
          {onDetail ? <Button key="back-to-list" label="Back to list" onPress={() => showList($)} /> : null}
          <Button key="view-review" label="Review" hotkey="c" dimColor={state.view !== 'review'} onPress={() => change($, s => ({ ...s, view: 'review' }))} />
          <Button key="refresh" label="Refresh" onPress={() => refreshList($)} />
          <Button key="backlog-close" label="Close" onPress={() => closePane($)} />
        </Box>
        <Text dimColor>{state.source ? `Source: ${clipped(state.source.root)}` : 'No source linked.'}</Text>
        {state.pendingList ? <Text>Loading list…</Text> : null}
        {state.listError ? <Text>{clipped(state.listError, 6000)}</Text> : null}
        {state.conflicts?.length ? <Text>{clipped(`Ambiguous IDs: ${state.conflicts.map(conflict => `${conflict.id} (${conflict.paths.length} files)`).join(', ')}. Other tasks remain browsable.`, 2000)}</Text> : null}
        {listFilters}
      </Box>
      <Box flexDirection="column" borderStyle="single" borderDimColor paddingX={1}>
        <Text dimColor>{onList ? 'Tasks · saved statuses' : onDetail ? 'Description' : 'Review'}</Text>
        {onList ? rowsBlock($, c, state) : detailBlock($, c, state)}
      </Box>
      <Box flexDirection="column">
        {contextSelector}
        <Box columnGap={1} flexWrap="wrap">
          <Button key="attach" label="Attach to next message" onPress={() => prepare($, false)} />
          <Button key="prepare-review" label="Prepare review" onPress={() => prepare($, true)} />
          <Button key="remove" label="Remove" onPress={() => change($, s => s.attachment.kind === 'validating' ? s : { ...s, attachment: { kind: 'none' } })} />
        </Box>
        {busy ? <Text>Attachment validation in progress. Task and context changes are locked.</Text> : null}
        {state.attachment.kind === 'failed' ? <Text>Attachment unavailable: {clipped(state.attachment.reason)} Remove or prepare again.</Text> : null}
        {state.attachment.kind === 'prepared' ? <Text>Ready for the next prompt: {state.attachment.taskId}.</Text> : null}
        <Text dimColor>Saved data only; no writes. Commands and text starting with '/' do not consume the attachment.</Text>
      </Box>
    </Box>
  })
}
