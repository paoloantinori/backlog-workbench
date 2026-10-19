import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, realpathSync, renameSync, copyFileSync, existsSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertBundledRequires } from './bundle-audit.mjs'

const reader = resolve(import.meta.dirname, '../plugin/reader.cjs')
function fixture(prefix = 'demo') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'backlog-reader-test-')))
  mkdirSync(join(root, 'backlog/tasks'), { recursive: true })
  writeFileSync(join(root, 'backlog/config.yml'), `project_name: test\ntask_prefix: ${prefix}\n`)
  return root
}
function task(root, file, id, title = id) {
  const path = join(root, 'backlog', file)
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, `---\nid: ${id}\ntitle: ${title}\nstatus: To Do\ndependencies: []\n---\n\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\nDescription of ${id}\n<!-- SECTION:DESCRIPTION:END -->\n\n## Acceptance Criteria\n\n<!-- AC:BEGIN -->\n- [ ] #1 Criterion of ${id}\n<!-- AC:END -->\n\n## Definition of Done\n\n<!-- DOD:BEGIN -->\n- [x] #1 Saved DoD\n<!-- DOD:END -->\n`)
}
function run(root, ...args) {
  return spawnSync(process.execPath, [reader, '--root', root, ...args], { cwd: root, encoding: 'utf8', timeout: 15000 })
}
function runWithoutRoot(root, args) {
  return spawnSync(process.execPath, [reader, ...args], { cwd: root, encoding: 'utf8', timeout: 15000 })
}
function files(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile())
    .map(e => join(e.parentPath, e.name)).sort().map(p => [p, readFileSync(p, 'utf8')])
}

test('active and archived collision leaves unrelated tasks readable and source untouched', () => {
  const root = fixture()
  task(root, 'tasks/demo-a.md', 'DEMO-1')
  task(root, 'archive/tasks/demo-b.md', 'DEMO-1')
  task(root, 'tasks/demo-c.md', 'DEMO-2')
  const before = files(root)
  const listing = run(root, 'list')
  assert.equal(listing.status, 0, listing.stderr)
  const data = JSON.parse(listing.stdout)
  assert.deepEqual(data.tasks.map(t => t.id), ['DEMO-1', 'DEMO-2'])
  assert.deepEqual(data.conflicts, [{ id: 'DEMO-1', paths: ['backlog/archive/tasks/demo-b.md', 'backlog/tasks/demo-a.md'] }])
  const detail = run(root, 'view', 'DEMO-2')
  assert.equal(detail.status, 0, detail.stderr)
  const record = JSON.parse(detail.stdout).task
  assert.equal(record.description, 'Description of DEMO-2')
  assert.deepEqual(record.acceptanceCriteria, [{ index: 1, text: 'Criterion of DEMO-2', checked: false }])
  assert.deepEqual(record.definitionOfDone, [{ index: 1, text: 'Saved DoD', checked: true }])
  const ambiguous = run(root, 'view', 'DEMO-1')
  assert.notEqual(ambiguous.status, 0)
  assert.match(ambiguous.stderr, /Ambiguous task ID DEMO-1/)
  assert.deepEqual(files(root), before)
})

test('canonical collisions and completed tasks are considered without hiding the list', () => {
  const root = fixture()
  task(root, 'tasks/demo-a.md', 'DEMO-01')
  task(root, 'completed/demo-b.md', 'demo-1')
  task(root, 'tasks/demo-c.md', 'DEMO-2')
  const result = run(root, 'list')
  assert.equal(result.status, 0, result.stderr)
  const data = JSON.parse(result.stdout)
  assert.equal(data.conflicts[0].id, 'DEMO-1')
  assert.equal(data.tasks.length, 2)
  assert.notEqual(run(root, 'view', 'DEMO-1').status, 0)
})

test('active duplicates produce one ambiguity row rather than arbitrary task details', () => {
  const root = fixture()
  task(root, 'tasks/demo-a.md', 'DEMO-1', 'First')
  task(root, 'tasks/demo-b.md', 'DEMO-1', 'Second')
  const data = JSON.parse(run(root, 'list').stdout)
  assert.equal(data.tasks.length, 1)
  assert.match(data.tasks[0].title, /ambigu/i)
  assert.equal(data.conflicts[0].paths.length, 2)
  assert.notEqual(run(root, 'view', 'DEMO-1').status, 0)
})

test('task symlink outside the project fails without reading the external task', () => {
  const root = fixture(), other = fixture()
  task(other, 'tasks/demo-a.md', 'DEMO-1')
  symlinkSync(join(other, 'backlog/tasks/demo-a.md'), join(root, 'backlog/tasks/demo-a.md'))
  const result = run(root, 'list')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /outside|symlink/i)
})

test('executable frontmatter is refused instead of evaluated', () => {
  const root = fixture()
  writeFileSync(join(root, 'backlog/tasks/demo-a.md'), '---js\n({id: "DEMO-1", title: "unsafe"})\n---\n')
  const result = run(root, 'list')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /YAML|frontmatter/i)
})

test('documentation files do not participate in task discovery', () => {
  const root = fixture()
  task(root, 'tasks/demo-1 - One.md', 'DEMO-1')
  writeFileSync(join(root, 'backlog/tasks/README.md'), '# Documentation, not a task')
  mkdirSync(join(root, 'backlog/archive/tasks'), { recursive: true })
  writeFileSync(join(root, 'backlog/archive/tasks/README.md'), '# Archive documentation')
  const listing = run(root, 'list')
  assert.equal(listing.status, 0, listing.stderr)
  assert.deepEqual(JSON.parse(listing.stdout).tasks.map(t => t.id), ['DEMO-1'])
  assert.equal(run(root, 'view', 'DEMO-1').status, 0)
})

test('legacy numeric identity is normalized before grouping', () => {
  const root = fixture('task')
  task(root, 'tasks/task-1 - One.md', '1', 'Legacy numeric task')
  const listing = run(root, 'list')
  assert.equal(listing.status, 0, listing.stderr)
  assert.deepEqual(JSON.parse(listing.stdout).tasks.map(t => t.id), ['TASK-1'])
  const detail = run(root, 'view', 'TASK-1')
  assert.equal(detail.status, 0, detail.stderr)
  assert.equal(JSON.parse(detail.stdout).task.id, 'TASK-1')
})

test('alphanumeric prefixes have canonical collision identities', () => {
  const root = fixture('a1')
  task(root, 'tasks/a1-1.md', 'A1-1')
  task(root, 'archive/tasks/a1-01.md', 'a1-01')
  task(root, 'tasks/a1-2.md', 'A1-2')
  const result = run(root, 'list')
  assert.equal(result.status, 0, result.stderr)
  const listing = JSON.parse(result.stdout)
  assert.deepEqual(listing.tasks.map(t => t.id), ['A1-1', 'A1-2'])
  assert.equal(listing.conflicts[0]?.id, 'A1-1')
  assert.notEqual(run(root, 'view', 'A1-1').status, 0)
})

test('default task ordering respects priority before ID', () => {
  const root = fixture()
  for (const [id, priority] of [['DEMO-1', 'low'], ['DEMO-2', 'high'], ['DEMO-3', 'medium']]) {
    task(root, `tasks/${id.toLowerCase()}.md`, id)
    const file = join(root, 'backlog/tasks', `${id.toLowerCase()}.md`)
    writeFileSync(file, readFileSync(file, 'utf8').replace('status: To Do', `status: To Do\npriority: ${priority}`))
  }
  const result = run(root, 'list')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).tasks.map(t => t.id), ['DEMO-2', 'DEMO-3', 'DEMO-1'])
})

test('configured priorities and ordinals use official ordering', () => {
  const root = fixture()
  const config = join(root, 'backlog/config.yml')
  writeFileSync(config, `${readFileSync(config, 'utf8')}priorities: [Urgent, Normal, Someday]\n`)
  for (const [id, priority, ordinal] of [['DEMO-1', 'Someday', 2], ['DEMO-2', 'Urgent', 2], ['DEMO-3', 'Normal', 1]]) {
    task(root, `tasks/${id.toLowerCase()}.md`, id)
    const file = join(root, 'backlog/tasks', `${id.toLowerCase()}.md`)
    writeFileSync(file, readFileSync(file, 'utf8').replace('status: To Do', `status: To Do\npriority: ${priority}\nordinal: ${ordinal}`))
  }
  const result = run(root, 'list')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).tasks.map(t => t.id), ['DEMO-3', 'DEMO-2', 'DEMO-1'])
})

test('a parent-directory swap is refused at the actual file open', () => {
  const root = fixture(), outside = fixture()
  task(root, 'tasks/demo-1.md', 'DEMO-1', 'Inside')
  task(outside, 'tasks/demo-1.md', 'DEMO-1', 'OUTSIDE_CANARY')
  const probeDir = mkdtempSync(join(tmpdir(), 'backlog-reader-probe-'))
  const probe = join(probeDir, 'swap.cjs')
  writeFileSync(probe, `
    const fs = require('node:fs');
    const promises = require('node:fs/promises');
    const original = promises.open;
    let swapped = false;
    promises.open = async function(path, ...args) {
      if (!swapped && String(path).endsWith('/tasks/demo-1.md')) {
        swapped = true;
        fs.renameSync(${JSON.stringify(join(root, 'backlog/tasks'))}, ${JSON.stringify(join(root, 'backlog/tasks-before'))});
        fs.symlinkSync(${JSON.stringify(join(outside, 'backlog/tasks'))}, ${JSON.stringify(join(root, 'backlog/tasks'))});
        process.stderr.write('SWAP_EXECUTED\\n');
      }
      return original.call(this, path, ...args);
    };
  `)
  const result = spawnSync(process.execPath, ['--require', probe, reader, '--root', root, 'view', 'DEMO-1'], { cwd: root, encoding: 'utf8', timeout: 15000 })
  assert.match(result.stderr, /SWAP_EXECUTED/)
  assert.notEqual(result.status, 0, 'Reader followed the replaced parent directory')
  assert.doesNotMatch(result.stdout, /OUTSIDE_CANARY/)
  assert.match(result.stderr, /ELOOP|symlink/i)
})

test('a newly introduced collision is rejected by a fresh detail read', () => {
  const root = fixture()
  task(root, 'tasks/demo-a.md', 'DEMO-1')
  assert.equal(run(root, 'view', 'DEMO-1').status, 0)
  task(root, 'archive/tasks/demo-b.md', 'DEMO-1')
  assert.notEqual(run(root, 'view', 'DEMO-1').status, 0)
})

test('a missing expected root is refused without reading the corpus', () => {
  const root = fixture()
  task(root, 'tasks/demo-a.md', 'DEMO-1')
  const result = runWithoutRoot(root, ['list'])
  assert.notEqual(result.status, 0, 'The reader ran without an expected root')
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /root/i)
})

test('a wrong expected root is refused before any corpus read', () => {
  const root = fixture(), other = fixture()
  task(root, 'tasks/demo-a.md', 'DEMO-1')
  task(other, 'tasks/demo-a.md', 'DEMO-1')
  const result = spawnSync(process.execPath, [reader, '--root', other, 'list'], { cwd: root, encoding: 'utf8', timeout: 15000 })
  assert.notEqual(result.status, 0, 'The reader accepted a root that does not match its cwd')
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /root/i)
})

test('the project root replaced by a symlink before launch is refused', () => {
  const root = fixture(), outside = fixture()
  task(root, 'tasks/demo-1.md', 'DEMO-1', 'INSIDE_ROOT')
  task(outside, 'tasks/demo-1.md', 'DEMO-1', 'OUTSIDE_CANARY')
  renameSync(root, `${root}-moved`)
  symlinkSync(outside, root)
  const result = spawnSync(process.execPath, [reader, '--root', root, 'view', 'DEMO-1'], { cwd: root, encoding: 'utf8', timeout: 15000 })
  assert.notEqual(result.status, 0, 'The reader followed a replaced root')
  assert.equal(result.stdout, '')
  assert.doesNotMatch(result.stderr, /OUTSIDE_CANARY/)
  assert.match(result.stderr, /root/i)
})

test('numeric ids and dependencies adopt the configured task prefix', () => {
  const root = fixture('custom')
  task(root, 'tasks/custom-1.md', '1', 'Numeric custom task')
  const file = join(root, 'backlog/tasks/custom-1.md')
  writeFileSync(file, readFileSync(file, 'utf8').replace('dependencies: []', 'dependencies: [2]'))
  const listing = run(root, 'list')
  assert.equal(listing.status, 0, listing.stderr)
  assert.deepEqual(JSON.parse(listing.stdout).tasks.map(t => t.id), ['CUSTOM-1'])
  const detail = run(root, 'view', '1')
  assert.equal(detail.status, 0, detail.stderr)
  const record = JSON.parse(detail.stdout).task
  assert.equal(record.id, 'CUSTOM-1')
  assert.deepEqual(record.dependencies, ['CUSTOM-2'])
})

test('a numeric custom-prefix id collides with the explicit prefixed id', () => {
  const root = fixture('custom')
  task(root, 'tasks/custom-1.md', '1', 'Numeric spelling')
  task(root, 'archive/tasks/custom-9.md', 'CUSTOM-1', 'Explicit spelling')
  const listing = run(root, 'list')
  assert.equal(listing.status, 0, listing.stderr)
  const data = JSON.parse(listing.stdout)
  assert.deepEqual(data.tasks.map(t => t.id), ['CUSTOM-1'])
  assert.deepEqual(data.conflicts, [{ id: 'CUSTOM-1', paths: ['backlog/archive/tasks/custom-9.md', 'backlog/tasks/custom-1.md'] }])
  assert.notEqual(run(root, 'view', 'CUSTOM-1').status, 0)
})

test('bundle audit accepts emitted builtin calls and rejects external or opaque loads', () => {
  for (const source of [
    'const fs = require("node:fs");',
    'var _require; _require = require; const b = _require("buffer");',
    'const first = require; const second = first; second("fs");',
    'const require_local = () => 1; require_local();',
  ]) assert.doesNotThrow(() => assertBundledRequires(source), source)
  for (const source of [
    'require("esprima");',
    '_require = require; _require("esprima"); var _require;',
    'const first = require; const second = first; second("./external.cjs");',
    'require("/tmp/external.cjs");',
    'require(name);',
    'const loader = require; loader(name);',
    'require("node:not-a-builtin");',
    'require("f" + "s");',
    'require("\\\\x66s");',
    'require.resolve("esprima");',
    'module["require"]("esprima");',
    'require.call(null, "esprima");',
    'import("esprima");',
  ]) assert.throws(() => assertBundledRequires(source), /module|require|import/i, source)
})

test('bundle audit rejects the original indirect esprima regression in the emitted artifact', () => {
  const bundle = readFileSync(reader, 'utf8')
  assert.doesNotThrow(() => assertBundledRequires(bundle))
  assert.ok(bundle.includes('_require("buffer")'))
  assert.throws(() => assertBundledRequires(bundle.replace('_require("buffer")', '_require("esprima")')), /esprima/)
})

test('bundle initialization requests no non-builtin modules', () => {
  const root = fixture()
  task(root, 'tasks/demo-a.md', 'DEMO-1')
  const probeDir = mkdtempSync(join(tmpdir(), 'backlog-reader-probe-'))
  const auditLog = `${root}-audit.json`
  writeFileSync(join(probeDir, 'audit.cjs'), `
    const Module = require('node:module');
    const fs = require('node:fs');
    const seen = [];
    const original = Module._load;
    Module._load = function (request) { seen.push(request); return original.apply(this, arguments); };
    process.on('exit', () => { try { fs.writeFileSync(${JSON.stringify(auditLog)}, JSON.stringify(seen)); } catch {} });
  `)
  const result = spawnSync(process.execPath, ['--require', join(probeDir, 'audit.cjs'), reader, '--root', root, 'list'],
    { cwd: root, encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr)
  const requests = JSON.parse(readFileSync(auditLog, 'utf8'))
  assert.ok(requests.includes(reader), 'The audit must observe the reader entrypoint')
  const foreign = requests.filter(request => request !== reader && !isBuiltin(request))
  assert.deepEqual(foreign, [])
})

test('an esprima canary in an ancestor node_modules is never loaded', () => {
  const base = mkdtempSync(join(tmpdir(), 'backlog-reader-canary-'))
  mkdirSync(join(base, 'node_modules/esprima'), { recursive: true })
  writeFileSync(join(base, 'node_modules/esprima/package.json'), `${JSON.stringify({ name: 'esprima', version: '0.0.0-canary', main: 'index.js' }, null, 2)}\n`)
  writeFileSync(join(base, 'node_modules/esprima/index.js'), [
    "const fs = require('node:fs');",
    "fs.writeFileSync(__dirname + '/CANARY_FIRED', 'esprima canary executed');",
    "process.stderr.write('ESPRIMA_CANARY_LOADED\\n');",
    "throw new Error('esprima canary must not be loaded');",
  ].join('\n'))
  mkdirSync(join(base, 'plugin'))
  copyFileSync(reader, join(base, 'plugin/reader.cjs'))
  const root = fixture()
  task(root, 'tasks/demo-a.md', 'DEMO-1')
  const result = spawnSync(process.execPath, [join(base, 'plugin/reader.cjs'), '--root', root, 'list'],
    { cwd: root, encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stderr, /ESPRIMA_CANARY/)
  assert.equal(JSON.parse(result.stdout).tasks[0].id, 'DEMO-1')
  assert.equal(existsSync(join(base, 'node_modules/esprima/CANARY_FIRED')), false, 'The esprima canary module executed')
})

test('shipped third-party notices cover the bundled dependency closure', () => {
  const bundle = readFileSync(reader, 'utf8')
  const notices = readFileSync(resolve(import.meta.dirname, '../plugin/THIRD_PARTY_NOTICES.md'), 'utf8')
  const bundled = new Set()
  for (const match of bundle.matchAll(/^\/\/ node_modules\/(@[^/]+\/[^/]+|[^/]+)\//gm)) bundled.add(match[1])
  for (const required of ['gray-matter', 'js-yaml']) {
    assert.ok(bundled.has(required), `expected ${required} in the bundled closure, found ${[...bundled].join(', ')}`)
  }
  for (const name of bundled) {
    assert.match(notices, new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@`, 'm'), `Missing notice for ${name}`)
  }
  assert.match(notices, /^## Backlog\.md/m)
  assert.match(notices, /default_full/, 'The js-yaml schema replacement must be disclosed')
})
