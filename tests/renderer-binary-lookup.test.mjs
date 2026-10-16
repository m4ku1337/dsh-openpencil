// Host-side executable lookup on Windows (issue #9).
//
// `openpencil_render` failed outright on Windows: `findOpenPencilBinary()` probed the
// bare name `openpencil-desktop` while the shipped file is `openpencil-desktop.exe`,
// and `findJianBinary()` both omitted the suffix and split PATH on ':' instead of
// `path.delimiter`, so every drive letter was torn away from its path. The tool then
// died in `spawn jian ENOENT` even with both binaries sitting on PATH.
//
// These cases drive the built host module (`lib/renderer.js`) against a temporary
// directory prepended to PATH, so they prove the platform spelling rule rather than a
// hard-coded string. POSIX runs the same assertions with no suffix.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'

const { findJianBinary, findOpenPencilBinary } = await import('../lib/renderer.js')

const WINDOWS = process.platform === 'win32'
// What Windows itself would append: a bare name has no chance without it.
const SUFFIX = WINDOWS ? '.exe' : ''

/** Same path, modulo the spelling a case-insensitive filesystem reports back. */
function samePath(actual, expected) {
  return WINDOWS ? actual.toLowerCase() === expected.toLowerCase() : actual === expected
}

/** Run `body` with PATH entries REPLACED (for the not-found cases: the machine
 *  that runs this suite may well have a real renderer installed). */
function withOnlyPath(entries, body) {
  const previous = process.env.PATH
  process.env.PATH = entries.join(delimiter)
  try {
    return body()
  } finally {
    process.env.PATH = previous
  }
}

/** Run `body` with PATH entries prepended, then restore the environment. */
function withPath(entries, body) {
  const previous = process.env.PATH
  process.env.PATH = [...entries, previous ?? ''].join(delimiter)
  try {
    return body()
  } finally {
    process.env.PATH = previous
  }
}

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('finds the exact renderer under its platform executable name', () => {
  const dir = tempDir('op-binary-renderer-')
  try {
    const binary = join(dir, 'openpencil-desktop' + SUFFIX)
    writeFileSync(binary, 'stub')
    withPath([dir], () => {
      const found = findOpenPencilBinary()
      assert.notEqual(found, undefined)
      assert.ok(samePath(found, binary), found + ' should be ' + binary)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('finds jian on PATH across every entry (the drive-letter split regression)', () => {
  const empty = tempDir('op-binary-empty-')
  const later = tempDir('op-binary-jian-')
  try {
    const binary = join(later, 'jian' + SUFFIX)
    writeFileSync(binary, 'stub')
    // The binary is only in the SECOND entry: a scan that splits PATH on ':'
    // (instead of path.delimiter) loses every Windows entry that carries a
    // drive letter and never reaches it.
    withPath([empty, later], () => {
      const found = findJianBinary()
      assert.ok(samePath(found, binary), found + ' should be ' + binary)
    })
  } finally {
    rmSync(empty, { recursive: true, force: true })
    rmSync(later, { recursive: true, force: true })
  }
})

test('keeps the documented fallbacks when nothing is installed', () => {
  const empty = tempDir('op-binary-none-')
  const previousBinary = process.env.DSHPLUGIN_OPENPENCIL_BINARY
  const previousJian = process.env.DSHPLUGIN_OPENPENCIL_JIAN
  delete process.env.DSHPLUGIN_OPENPENCIL_BINARY
  delete process.env.DSHPLUGIN_OPENPENCIL_JIAN
  try {
    withOnlyPath([empty], () => {
      assert.equal(findOpenPencilBinary(), undefined)
      // Jian keeps its historical last resort: the bare name, resolved by the
      // platform's normal executable search at spawn time.
      assert.equal(findJianBinary(), 'jian')
    })
  } finally {
    if (previousBinary === undefined) delete process.env.DSHPLUGIN_OPENPENCIL_BINARY
    else process.env.DSHPLUGIN_OPENPENCIL_BINARY = previousBinary
    if (previousJian === undefined) delete process.env.DSHPLUGIN_OPENPENCIL_JIAN
    else process.env.DSHPLUGIN_OPENPENCIL_JIAN = previousJian
    rmSync(empty, { recursive: true, force: true })
  }
})

test('an explicit override wins over PATH', () => {
  const dir = tempDir('op-binary-override-')
  const explicit = join(dir, 'custom-jian' + SUFFIX)
  const previousJian = process.env.DSHPLUGIN_OPENPENCIL_JIAN
  try {
    writeFileSync(explicit, 'stub')
    process.env.DSHPLUGIN_OPENPENCIL_JIAN = explicit
    assert.equal(findJianBinary(), explicit)
  } finally {
    if (previousJian === undefined) delete process.env.DSHPLUGIN_OPENPENCIL_JIAN
    else process.env.DSHPLUGIN_OPENPENCIL_JIAN = previousJian
    rmSync(dir, { recursive: true, force: true })
  }
})
test('a .cmd shim on PATH never shadows a runnable .exe', () => {
  // `spawn` runs without `shell: true`, and Node refuses to start a .cmd/.bat that
  // way (CVE-2024-27980). Returning a shim would replace a graceful "renderer
  // missing, use the Jian preview" with EINVAL out of the tool.
  const shimDir = tempDir('op-binary-shim-')
  const realDir = tempDir('op-binary-real-')
  try {
    writeFileSync(join(shimDir, 'jian.cmd'), 'stub')
    writeFileSync(join(shimDir, 'openpencil-desktop.cmd'), 'stub')
    writeFileSync(join(realDir, 'jian' + SUFFIX), 'stub')
    writeFileSync(join(realDir, 'openpencil-desktop' + SUFFIX), 'stub')
    withPath([shimDir, realDir], () => {
      const jian = findJianBinary()
      const renderer = findOpenPencilBinary()
      assert.equal(/\.(cmd|bat)$/i.test(jian), false, 'jian must not resolve to a shim: ' + jian)
      assert.equal(/\.(cmd|bat)$/i.test(renderer), false, 'renderer must not resolve to a shim: ' + renderer)
      assert.ok(samePath(jian, join(realDir, 'jian' + SUFFIX)), jian + ' should be the runnable spelling')
      assert.ok(samePath(renderer, join(realDir, 'openpencil-desktop' + SUFFIX)), String(renderer))
    })
  } finally {
    rmSync(shimDir, { recursive: true, force: true })
    rmSync(realDir, { recursive: true, force: true })
  }
})

test('an empty or whitespace PATHEXT still finds the platform spelling', () => {
  const dir = tempDir('op-binary-noext-')
  const previous = process.env.PATHEXT
  try {
    writeFileSync(join(dir, 'openpencil-desktop' + SUFFIX), 'stub')
    for (const value of ['', '   ']) {
      process.env.PATHEXT = value
      withPath([dir], () => {
        const found = findOpenPencilBinary()
        assert.ok(found !== undefined && samePath(found, join(dir, 'openpencil-desktop' + SUFFIX)), value + ' -> ' + String(found))
      })
    }
  } finally {
    if (previous === undefined) delete process.env.PATHEXT
    else process.env.PATHEXT = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('only the platform spelling is probed', () => {
  const dir = tempDir('op-binary-spelling-')
  try {
    writeFileSync(join(dir, 'openpencil-desktop.exe'), 'stub')
    withOnlyPath([dir], () => {
      if (WINDOWS) {
        assert.ok(samePath(findOpenPencilBinary(), join(dir, 'openpencil-desktop.exe')))
      } else {
        // POSIX must not invent a suffix: the .exe file is not a candidate there.
        assert.equal(findOpenPencilBinary(), undefined)
      }
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the renderer override wins over PATH', () => {
  const dir = tempDir('op-binary-renderer-override-')
  const previous = process.env.DSHPLUGIN_OPENPENCIL_BINARY
  try {
    const explicit = join(dir, 'my-renderer' + SUFFIX)
    writeFileSync(explicit, 'stub')
    writeFileSync(join(dir, 'openpencil-desktop' + SUFFIX), 'stub')
    process.env.DSHPLUGIN_OPENPENCIL_BINARY = explicit
    withPath([dir], () => {
      assert.ok(samePath(findOpenPencilBinary(), explicit), String(findOpenPencilBinary()))
    })
  } finally {
    if (previous === undefined) delete process.env.DSHPLUGIN_OPENPENCIL_BINARY
    else process.env.DSHPLUGIN_OPENPENCIL_BINARY = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the documented Jian build location is preferred over PATH', t => {
  // Creates only the directories it needs, and removes only those it created.
  const parts = [homedir(), 'workspace', 'jian', 'target', 'release']
  const target = join(...parts, 'jian' + SUFFIX)
  const bare = join(...parts, 'jian')
  if (existsSync(target) || existsSync(bare)) {
    t.skip('a real jian build already exists at the documented location')
    return
  }
  const created = []
  let base = parts[0]
  for (const part of parts.slice(1)) {
    base = join(base, part)
    if (!existsSync(base)) {
      mkdirSync(base)
      created.push(base)
    }
  }
  const dir = tempDir('op-binary-buildlocation-')
  try {
    writeFileSync(target, 'stub')
    writeFileSync(join(dir, 'jian' + SUFFIX), 'stub')
    withPath([dir], () => {
      assert.ok(samePath(findJianBinary(), target), String(findJianBinary()))
    })
  } finally {
    for (const stale of created.reverse()) {
      try { rmSync(stale, { recursive: true, force: true }) } catch { /* best effort */ }
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
test('the FIRST PATH entry that has a match wins', () => {
  // Windows resolves PATH left to right; a resolver that returns the last match
  // silently runs a different renderer than the shell would.
  const first = tempDir('op-binary-first-')
  const second = tempDir('op-binary-second-')
  try {
    writeFileSync(join(first, 'openpencil-desktop' + SUFFIX), 'stub')
    writeFileSync(join(second, 'openpencil-desktop' + SUFFIX), 'stub')
    writeFileSync(join(first, 'jian' + SUFFIX), 'stub')
    writeFileSync(join(second, 'jian' + SUFFIX), 'stub')
    withOnlyPath([first, second], () => {
      assert.ok(samePath(findOpenPencilBinary(), join(first, 'openpencil-desktop' + SUFFIX)), String(findOpenPencilBinary()))
      assert.ok(samePath(findJianBinary(), join(first, 'jian' + SUFFIX)), String(findJianBinary()))
    })
  } finally {
    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
  }
})
