#!/usr/bin/env node
/**
 * Release packaging for the Ling Gao 校对员 (Ling Gao Proofreader) plugin
 * (Task 20; design §12.3).
 *
 * `pnpm release` (or `pnpm package:release`) always performs the full pipeline:
 *
 * 1. rebuild both artifacts (`scripts/build.mjs`);
 * 2. validate the package (`scripts/validate.mjs`);
 * 3. collect the install whitelist — runtime files only, never `src/`, `assets/`,
 *    `tests/`, `scripts/`, `node_modules/`, `.superpowers/` or previous releases;
 * 4. write `release/LGProofreader-<version>.zip` (unpacks to `LGProofreader/`) and
 *    `release/LGProofreader-<version>.tgz` (npm-compatible `package/` tarball,
 *    installable by DSH **Add plugin**); both archives are built from the same
 *    staged file set, so their contents are identical;
 * 5. verify the archives round-trip to the expected file list and that a second
 *    build produces byte-identical output (fixed timestamps + sorted entries);
 * 6. write `release/SHA256SUMS.txt`.
 *
 * The archives are generated directly instead of shelling out to `pnpm pack`
 * (pnpm is not on PATH in the document's build environment) so the ZIP and TGZ
 * always contain exactly the same whitelist. The TGZ layout (`package/` +
 * `package.json`) is the npm pack format DSH installs.
 *
 * Node.js built-ins only; not shipped.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateRawSync, gunzipSync, gzipSync } from 'node:zlib'

/** Repository/package root (this file lives in `<root>/scripts/`). */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Output directory (git-ignored). */
const RELEASE_DIR = join(ROOT, 'release')

/** ZIP root directory name (design §12.3). */
const ZIP_ROOT = 'LGProofreader'

/** TGZ root directory name (npm pack layout). */
const TAR_ROOT = 'package'

/** Fixed modification time stored in both archives (2020-01-01T00:00:00Z). */
const FIXED_MTIME_SECONDS = 1_577_836_800

/** Fixed DOS date/time (2020-01-01 00:00:00). */
const DOS_TIME = 0
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1

/** Files shipped at the package root (design §12.3). */
const ROOT_FILES = [
  'package.json',
  'cordis.patch.yml',
  'icon.png',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
]

/** Runtime directories shipped as-is (design §12.2/§12.3). */
const RUNTIME_DIRS = ['lib', 'locale', 'prompts']

/** Detail documents + feature image named by `meta.detail` (plugin-details). */
const DOC_FILES = ['docs/DETAIL.md', 'docs/DETAIL.zh.md', 'docs/preview.svg']

/** Nothing outside this whitelist may enter an archive. */
const ALLOWED_FILES = new Set([...ROOT_FILES, ...DOC_FILES])

/** Prefixes that are never install-relevant (defence in depth). */
const FORBIDDEN_PREFIXES = [
  'node_modules/',
  'src/',
  'assets/',
  'tests/',
  'scripts/',
  'release/',
  '.git/',
]

/* ------------------------------------------------------------------------- */
/* File collection                                                             */
/* ------------------------------------------------------------------------- */

/** Recursively list files below `dir` as sorted POSIX paths relative to `root`. */
async function listFiles(root, dir) {
  const entries = await readdir(join(root, dir), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relative = `${dir}/${entry.name}`
    if (entry.isSymbolicLink()) {
      throw new Error(`release whitelist must not follow symlinks: ${relative}`)
    }
    if (entry.isDirectory()) files.push(...(await listFiles(root, relative)))
    else if (entry.isFile()) files.push(relative)
  }
  return files
}

/**
 * Collect the install whitelist as sorted POSIX paths.
 *
 * Throws when a required file is missing or a forbidden path sneaks in, so a
 * broken build can never produce a partial archive.
 */
export async function collectReleaseFiles(root = ROOT) {
  const files = new Set(ROOT_FILES)

  for (const dir of RUNTIME_DIRS) {
    for (const relative of await listFiles(root, dir)) {
      if (relative.endsWith('.map')) continue
      files.add(relative)
    }
  }
  for (const relative of DOC_FILES) files.add(relative)

  const sorted = [...files].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))

  for (const relative of sorted) {
    for (const forbidden of FORBIDDEN_PREFIXES) {
      if (relative === forbidden.replace(/\/$/u, '') || relative.startsWith(forbidden)) {
        throw new Error(`forbidden release path: ${relative}`)
      }
    }
    if (relative.includes('\\')) throw new Error(`release paths must use '/': ${relative}`)
    if (relative.startsWith('/') || relative.split('/').includes('..')) {
      throw new Error(`release path must stay inside the package: ${relative}`)
    }
    const info = await stat(join(root, ...relative.split('/')))
    if (!info.isFile()) throw new Error(`release path is not a file: ${relative}`)
  }

  await assertReleaseReady(root, sorted)
  return sorted
}

/** Reject a whitelist that would produce an unusable plugin package. */
async function assertReleaseReady(root, files) {
  const required = [
    'package.json',
    'cordis.patch.yml',
    'icon.png',
    'lib/index.js',
    'lib/client.js',
    'locale/en.json',
    'locale/zh.json',
    'prompts/zh/base.md',
    'prompts/zh/contracts/findings.schema.json',
    'docs/DETAIL.md',
    'docs/DETAIL.zh.md',
    'docs/preview.svg',
    'README.md',
    'CHANGELOG.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
  ]
  for (const relative of required) {
    if (!files.includes(relative)) throw new Error(`release whitelist is missing ${relative}`)
  }
}

/** Read the staged whitelist into sorted `{ path, data }` entries. */
async function readArchiveInput(stageDir, files) {
  const entries = []
  for (const relative of files) {
    entries.push({ path: relative, data: await readFile(join(stageDir, ...relative.split('/'))) })
  }
  return entries
}

/* ------------------------------------------------------------------------- */
/* Deterministic ZIP                                                           */
/* ------------------------------------------------------------------------- */

/** CRC-32 (IEEE 802.3) lookup table, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let value = n
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[n] = value >>> 0
  }
  return table
})()

/** Compute the CRC-32 of one buffer. */
export function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Build one deterministic ZIP archive. */
export function buildZip(entries, zipRoot = ZIP_ROOT) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(`${zipRoot}/${entry.path}`, 'utf8')
    const data = entry.data
    const compressed = deflateRawSync(data, { level: 9 })
    const stored = compressed.length >= data.length
    const payload = stored ? data : compressed
    const method = stored ? 0 : 8
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed to extract
    local.writeUInt16LE(0x0800, 6) // UTF-8 file name
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    localParts.push(local, name, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk start
    central.writeUInt16LE(0, 36) // internal attributes
    central.writeUInt32LE(0o100644 * 0x10000, 38) // unix file mode
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)

    offset += local.length + name.length + payload.length
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...localParts, ...centralParts, end])
}

/** List the file names stored in one ZIP buffer (round-trip verification). */
export function listZipEntries(zip) {
  let endOffset = -1
  for (let index = zip.length - 22; index >= 0; index -= 1) {
    if (zip.readUInt32LE(index) === 0x06054b50) {
      endOffset = index
      break
    }
  }
  if (endOffset < 0) throw new Error('ZIP is missing its end-of-central-directory record')
  const count = zip.readUInt16LE(endOffset + 10)
  let offset = zip.readUInt32LE(endOffset + 16)
  const names = []
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP central directory is corrupt')
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    names.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'))
    offset += 46 + nameLength + extraLength + commentLength
  }
  return names
}

/* ------------------------------------------------------------------------- */
/* Deterministic npm-compatible TGZ                                           */
/* ------------------------------------------------------------------------- */

/** Write one zero-padded octal field into a tar header. */
function writeTarOctal(header, value, offset, length) {
  const text = value.toString(8).padStart(length - 1, '0')
  header.write(`${text}\0`, offset, length, 'ascii')
}

/** Split a long path into the ustar `prefix`/`name` fields. */
function splitTarName(name) {
  if (Buffer.byteLength(name, 'utf8') <= 100) return { name, prefix: '' }
  for (let index = name.length - 1; index > 0; index -= 1) {
    if (name[index] !== '/') continue
    const prefix = name.slice(0, index)
    const rest = name.slice(index + 1)
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(rest, 'utf8') <= 100) {
      return { name: rest, prefix }
    }
  }
  throw new Error(`tar path is too long: ${name}`)
}

/** Build one 512-byte ustar header. */
function buildTarHeader(name, size) {
  const { name: shortName, prefix } = splitTarName(name)
  const header = Buffer.alloc(512, 0)
  header.write(shortName, 0, 100, 'utf8')
  writeTarOctal(header, 0o644, 100, 8) // mode
  writeTarOctal(header, 0, 108, 8) // uid
  writeTarOctal(header, 0, 116, 8) // gid
  writeTarOctal(header, size, 124, 12) // size
  writeTarOctal(header, FIXED_MTIME_SECONDS, 136, 12) // mtime
  header.write('        ', 148, 8, 'ascii') // checksum placeholder = spaces
  header.write('0', 156, 1, 'ascii') // regular file
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  header.write('root', 265, 32, 'ascii')
  header.write('root', 297, 32, 'ascii')
  writeTarOctal(header, 0, 329, 8) // devmajor
  writeTarOctal(header, 0, 337, 8) // devminor
  header.write(prefix, 345, 155, 'utf8')

  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

/** Build one deterministic npm-compatible `.tgz` buffer. */
export function buildTgz(entries, tarRoot = TAR_ROOT) {
  const parts = []
  for (const entry of entries) {
    const name = `${tarRoot}/${entry.path}`
    parts.push(buildTarHeader(name, entry.data.length), entry.data)
    const padding = entry.data.length % 512
    if (padding !== 0) parts.push(Buffer.alloc(512 - padding, 0))
  }
  parts.push(Buffer.alloc(1024, 0)) // end-of-archive marker
  const tar = Buffer.concat(parts)
  return gzipSync(tar, { level: 9 })
}

/** List the file names stored in one `.tgz` buffer (round-trip verification). */
export function listTgzEntries(tgz) {
  const tar = gunzipSync(tgz)
  const names = []
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const shortName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/su, '')
    if (shortName === '') break
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/su, '')
    const size = Number.parseInt(
      header.subarray(124, 136).toString('ascii').replace(/\0.*$/su, '').trim() || '0',
      8,
    )
    names.push(prefix === '' ? shortName : `${prefix}/${shortName}`)
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return names
}

/* ------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* ------------------------------------------------------------------------- */

/** Run a repo script with the current Node executable; inherit its output. */
function runScript(relative) {
  console.log(`release: running node ${relative}`)
  execFileSync(process.execPath, [join(ROOT, ...relative.split('/'))], {
    cwd: ROOT,
    stdio: 'inherit',
  })
}

/** SHA-256 hex digest of one buffer. */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Read and parse one JSON file. */
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function main() {
  const manifest = await readJson(join(ROOT, 'package.json'))
  const version = String(manifest.version)
  const archiveBase = `LGProofreader-${version}`

  // 1-2. Build and validate before packaging, so a stale artifact cannot ship.
  runScript('scripts/build.mjs')
  runScript('scripts/validate.mjs')

  // 3. Whitelist + staging.
  const files = await collectReleaseFiles(ROOT)
  await rm(RELEASE_DIR, { recursive: true, force: true })
  await mkdir(RELEASE_DIR, { recursive: true })
  const stageRoot = join(RELEASE_DIR, '.stage', ZIP_ROOT)
  for (const relative of files) {
    const target = join(stageRoot, ...relative.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await cp(join(ROOT, ...relative.split('/')), target)
  }
  const entries = await readArchiveInput(stageRoot, files)

  // 4. Deterministic archives from one staged file set.
  const zip = buildZip(entries)
  const tgz = buildTgz(entries)
  if (!buildZip(entries).equals(zip)) throw new Error('ZIP output is not deterministic')
  if (!buildTgz(entries).equals(tgz)) throw new Error('TGZ output is not deterministic')

  // 5. Round-trip verification: identical, sorted whitelist contents.
  const expectedZipNames = files.map((relative) => `${ZIP_ROOT}/${relative}`)
  const expectedTgzNames = files.map((relative) => `${TAR_ROOT}/${relative}`)
  const zipNames = listZipEntries(zip)
  const tgzNames = listTgzEntries(tgz)
  if (zipNames.join('\n') !== expectedZipNames.join('\n')) {
    throw new Error('ZIP contents differ from the release whitelist')
  }
  if (tgzNames.join('\n') !== expectedTgzNames.join('\n')) {
    throw new Error('TGZ contents differ from the release whitelist')
  }
  if (zipNames.length !== tgzNames.length) {
    throw new Error('ZIP and TGZ must contain the same file set')
  }
  for (const name of zipNames) {
    if (/^[A-Za-z]:[\\/]/u.test(name) || name.includes('..')) {
      throw new Error(`archive contains an unsafe path: ${name}`)
    }
  }

  const zipPath = join(RELEASE_DIR, `${archiveBase}.zip`)
  const tgzPath = join(RELEASE_DIR, `${archiveBase}.tgz`)
  await writeFile(zipPath, zip)
  await writeFile(tgzPath, tgz)

  // 6. SHA256SUMS (sorted file names, `<hex>  <name>` lines).
  const sums = [
    { name: `${archiveBase}.tgz`, hash: sha256(tgz) },
    { name: `${archiveBase}.zip`, hash: sha256(zip) },
  ].sort((left, right) => (left.name < right.name ? -1 : 1))
  const sumsText = `${sums.map(({ hash, name }) => `${hash}  ${name}`).join('\n')}\n`
  await writeFile(join(RELEASE_DIR, 'SHA256SUMS.txt'), sumsText, 'utf8')

  // Re-read the written archives so the reported hashes are the shipped bytes.
  for (const { name, hash } of sums) {
    const written = await readFile(join(RELEASE_DIR, name))
    if (sha256(written) !== hash) throw new Error(`${name} changed while writing`)
  }

  await rm(join(RELEASE_DIR, '.stage'), { recursive: true, force: true })

  console.log(`release: files ${files.length}`)
  console.log(`release: ${archiveBase}.zip ${(zip.length / 1024).toFixed(1)} KiB`)
  console.log(`release: ${archiveBase}.tgz ${(tgz.length / 1024).toFixed(1)} KiB`)
  for (const { name, hash } of sums) console.log(`release: sha256 ${name} ${hash}`)
  console.log('release: ok')
}

// Run only when executed as a script (the helpers stay importable by tooling).
if (isExecutedAsScript()) await main()

/** True when Node was asked to run this file directly, not to import it. */
function isExecutedAsScript() {
  const entry = process.argv[1]
  if (entry === undefined || entry === '') return false
  return pathToFileURL(resolve(entry)).href === import.meta.url
}
