import { isBuiltin } from 'node:module'

// This checks Bun's emitted CommonJS forms, not arbitrary JavaScript. Unknown
// uses of require fail closed; the reader tests also audit Node's actual loads.
export function assertBundledRequires(bundle) {
  if (/\bimport\s*(?:\(|["'{*])/.test(bundle)) throw new Error('Unexpected import in CommonJS bundle')
  const assignments = [...bundle.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/g)]
  const loaders = new Set(['require'])
  let previousSize
  do {
    previousSize = loaders.size
    for (const match of assignments) {
      if (loaders.has(match[2])) loaders.add(match[1])
    }
  } while (loaders.size !== previousSize)

  const aliases = assignments.filter(match => loaders.has(match[2]))
  for (const match of bundle.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const name = match[0]
    if (!loaders.has(name)) continue
    const index = match.index
    const before = bundle.slice(0, index)
    const after = bundle.slice(index + name.length)
    if (/[."']\s*$/.test(before)) throw new Error(`Unsupported module loader access: ${name}`)
    const alias = aliases.find(assignment => index >= assignment.index && index < assignment.index + assignment[0].length)
    if (alias) continue
    if (/\bvar\s+$/.test(before) && /^\s*;/.test(after) && name !== 'require') continue
    const call = /^\s*\(\s*(["'])([^"'\\\r\n]*)\1\s*\)/.exec(after)
    if (!call) throw new Error(`Unsupported require expression: ${name}`)
    if (!isBuiltin(call[2])) throw new Error(`External module request: ${call[2]}`)
  }
}
