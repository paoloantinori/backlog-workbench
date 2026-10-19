import { expect, test } from 'claude-code/testing'
import { confinedArgv, contextFor, taskRevision, parseDetail, parseList } from '../backlog'

const row = { id: 'DEMO-1', title: 'Synthetic task', status: 'Waiting Review' }
const task = {
  ...row, path: 'backlog/tasks/demo-1.md', description: 'Only synthetic data.', dependencies: [],
  acceptanceCriteria: [{ index: 1, text: 'First criterion', checked: false }],
  definitionOfDone: [{ index: 1, text: 'Saved DoD', checked: true }],
}
const detail = (value = task) => JSON.stringify({ schemaVersion: 1, kind: 'task-view', task: value })
const list = (tasks: unknown[] = [row]) => JSON.stringify({ schemaVersion: 1, kind: 'task-list', tasks })

test('official list keeps custom statuses and accepts an empty result', () => {
  expect(parseList(list())).toEqual({ tasks: [row], conflicts: [] })
  expect(parseList(list([]))).toEqual({ tasks: [], conflicts: [] })
})

test('unknown schema, invalid IDs and duplicate IDs fail closed', () => {
  expect(() => parseList(JSON.stringify({ schemaVersion: 2, kind: 'task-list', tasks: [] }))).toThrow('Unsupported schemaVersion 2')
  expect(() => parseList(list([{ ...row, id: '--help' }]))).toThrow('task id is not a valid task id')
  expect(() => parseList(list([row, row]))).toThrow('Duplicate task id DEMO-1')
  expect(() => parseList('not json')).toThrow('Invalid JSON for task-list')
})

test('detail checks identity and checklist types', () => {
  const parsed = parseDetail(detail(), 'DEMO-1')
  expect(parsed.ac).toEqual([{ text: 'First criterion', checked: false }])
  expect(parsed.dod).toEqual([{ text: 'Saved DoD', checked: true }])
  expect(() => parseDetail(detail(), 'DEMO-2')).toThrow()
  expect(() => parseDetail(detail({ ...task, acceptanceCriteria: [{ index: 1, text: 'Criterion', checked: 'yes' as unknown as boolean }] }), 'DEMO-1')).toThrow()
})

test('context distinguishes criteria, DoD, source and review request', () => {
  const parsed = parseDetail(detail(), 'DEMO-1')
  const source = { root: '/synthetic', sessionId: 'session-1' }
  const short = contextFor(parsed, source, 'short', false)
  const criteria = contextFor(parsed, source, 'criteria', false)
  const full = contextFor(parsed, source, 'full', true)
  expect(short).toContain('/synthetic')
  expect(short).toContain('DEMO-1')
  expect(short).not.toContain('First criterion')
  expect(criteria).toContain('First criterion')
  expect(criteria).not.toContain('Saved DoD')
  expect(full).toContain('Saved DoD')
  expect(full).not.toEqual(contextFor(parsed, source, 'full', false))
})

test('revision changes when a checklist marker or task text changes', () => {
  const parsed = parseDetail(detail(), 'DEMO-1')
  expect(taskRevision(parsed)).toEqual(taskRevision(parseDetail(detail(), 'DEMO-1')))
  expect(taskRevision({ ...parsed, ac: [{ text: 'First criterion', checked: true }] })).not.toEqual(taskRevision(parsed))
  expect(taskRevision({ ...parsed, title: 'Changed' })).not.toEqual(taskRevision(parsed))
})

test('confined invocation passes the expected canonical root before the mode', () => {
  const source = { root: '/synthetic/canonical/root', sessionId: 'session-1' }
  expect(confinedArgv('/plugins/backlog-workbench', source, ['list'])).toEqual([
    '/usr/bin/sandbox-exec',
    '-p',
    '(version 1)(allow default)(deny file-write*)(deny network*)',
    '/opt/homebrew/bin/node',
    '/plugins/backlog-workbench/reader.cjs',
    '--root',
    '/synthetic/canonical/root',
    'list',
  ])
  expect(confinedArgv('/plugins/backlog-workbench', source, ['view', 'DEMO-1'])).toEqual([
    '/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny file-write*)(deny network*)',
    '/opt/homebrew/bin/node', '/plugins/backlog-workbench/reader.cjs', '--root', source.root, 'view', 'DEMO-1',
  ])
})
