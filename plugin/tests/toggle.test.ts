import { expect, test } from 'claude-code/testing'
import type { RenderElement, UiPane } from 'claude-code'

const nativeModes: RenderElement = {
  type: 'Box',
  children: [{ type: 'Text', children: ['focus & memory paused'] }],
}

const nativeSurveyBand: RenderElement = {
  type: 'Box',
  children: [{ type: 'Text', children: ['Engine survey band'] }],
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Backlog opens and closes by the footer button on ${surface}`, async ($, on) => {
    let panes: UiPane[] = []
    let stats = 0
    const runs: (readonly string[])[] = []
    on('session.id', () => ({ value: 'toggle-session' }))
    on('session.root', () => ({ value: '/not-linked' }))
    on('fs.stat', () => {
      stats += 1
      return { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: false } }
    })
    on('process.run', ($, e) => {
      runs.push(e.argv)
      return { value: { exitCode: 1, isStdoutTruncated: false, isStderrTruncated: false, stdout: '', stderr: 'Synthetic read failure' } }
    })
    on('ui.render', ($, e) => e.component === 'SessionMode' ? nativeModes : { type: 'Box', children: [] })
    on('ui.panes', () => ({ value: panes }))
    on('ui.open', ($, e) => {
      panes = [{ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true }]
      return { value: { isPlaced: true } }
    })
    on('ui.close', () => {
      panes = []
      return { value: undefined }
    })
    const footer = await $.ui.mount({
      plugin: 'backlog-workbench', surface, component: 'SessionMode',
      props: { modes: ['focus', 'memory paused'] },
    })
    expect(await footer.findAll({ key: 'backlog-toggle' })).toHaveLength(1)
    expect(await footer.find({ type: 'Text', text: 'focus & memory paused' })).toBeDefined()
    const drawn = await footer.drawn() as { type?: string; props?: { flexDirection?: unknown; columnGap?: unknown } }
    expect(drawn.type).toBe('Box')
    expect(drawn.props?.flexDirection).toBe('row')
    expect(drawn.props?.columnGap).toBe(1)
    expect(panes).toEqual([])
    expect(stats).toBe(0)
    expect(runs).toEqual([])
    await footer.press({ key: 'backlog-toggle' })
    expect(panes.map(pane => pane.id)).toEqual(['backlog'])
    await footer.press({ key: 'backlog-toggle' })
    expect(panes).toEqual([])
  })

  for (const hasSurvey of [false, true]) {
    test(`the survey band keeps its own tree with no Backlog button (hasSurvey ${hasSurvey}) on ${surface}`, async ($, on) => {
      on('session.id', () => ({ value: 'toggle-session' }))
      on('session.root', () => ({ value: '/not-linked' }))
      on('fs.stat', () => ({ value: { kind: 'other', size: 0, mtimeMs: 0, isLink: false } }))
      on('ui.render', ($, e) => e.component === 'AbovePrompt' ? nativeSurveyBand : { type: 'Box', children: [] })
      const band = await $.ui.mount({
        plugin: 'backlog-workbench', surface, component: 'AbovePrompt',
        props: { hasSurvey, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
      })
      expect(await band.find({ type: 'Text', text: 'Engine survey band' })).toBeDefined()
      expect(await band.find({ key: 'backlog-toggle' })).toBeUndefined()
    })
  }
}

test('/backlog toggles the pane without a footer press', async ($, on) => {
  let panes: UiPane[] = []
  on('session.id', () => ({ value: 'toggle-session' }))
  on('session.root', () => ({ value: '/not-linked' }))
  on('fs.stat', () => ({ value: { kind: 'other', size: 0, mtimeMs: 0, isLink: false } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', () => ({ type: 'Box', children: [] }))
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', ($, e) => {
    panes = [{ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true }]
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    panes = []
    return { value: undefined }
  })
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/not-linked' })
  const run = { command: 'backlog', args: '', origin: { kind: 'composer' } as const, presentation: { isFullscreen: false, columns: 80 } }
  await $.command.run(run)
  expect(panes.map(pane => pane.id)).toEqual(['backlog'])
  await $.command.run(run)
  expect(panes).toEqual([])
})
