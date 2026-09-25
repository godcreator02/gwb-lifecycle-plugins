// devkit 0.19.1（commit e71d842）src/artifact-check.ts 里按行找 import 的写法，原样搬来作对照：只取说明符，不分包名与相对
const STATIC_IMPORT = /^(?:import|export)\s*(?:[\w$*{}\s,]*?\s*from\s*)?(['"])([^'"\n]+)\1/gm
const DYNAMIC_IMPORT = /\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/

export function oldSpecifiers(code) {
  const specs = []
  for (const match of code.matchAll(STATIC_IMPORT)) specs.push(match[2])
  for (const line of code.split(/\r?\n/)) {
    if (COMMENT_LINE.test(line)) continue
    for (const match of line.matchAll(DYNAMIC_IMPORT)) specs.push(match[2])
  }
  return [...new Set(specs)]
}
