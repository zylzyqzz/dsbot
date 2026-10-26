#!/usr/bin/env node
/**
 * Make ds-bot's browser screenshots render inside the conversation.
 *
 * The problem
 * -----------
 * ds-bot's `browserOutput.render` emits an image block as
 * `{ type: 'image', data: <base64>, mediaType: 'image/jpeg' }`. DSH only renders
 * an image block that carries a real attachment reference, and its image
 * pipeline reads `block.attachment.attachmentId` unconditionally
 * (`ds-bot/src/host/images.js`). A bare `data` field therefore throws
 * `Cannot read properties of undefined (reading 'attachmentId')` and the whole
 * turn fails — the screenshot never reaches the user.
 *
 * The fix
 * -------
 * Save the screenshot through DSH's own `attachments` service
 * (`saveImages([{ mediaType, data, name }])`) and hand the returned reference to
 * `render`, which emits `{ type: 'image', attachment }` — the same shape DSH
 * uses for a picture the user pasted.
 *
 * This patches a dependency, so it is a script rather than a hand edit: it is
 * idempotent, backs up the file, refuses to guess when the source does not match,
 * and validates the result with `node --check`.
 *
 *   node scripts/patch-ds-bot-image.mjs                    # patch the web profile
 *   node scripts/patch-ds-bot-image.mjs --dry-run           # show what would change
 *   node scripts/patch-ds-bot-image.mjs --path <ds-bot dir>
 *   node scripts/patch-ds-bot-image.mjs --revert            # restore the backup
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

export const MARKER = 'dsbot:screenshot-attachment'
export const HISTORY_MARKER = 'dsbot:image-block-guard'
const RELATIVE = join('src', 'host', 'browser', 'mount.js')
const IMAGES_RELATIVE = join('src', 'host', 'images.js')

/** The three edits, each anchored on text that must exist verbatim. */
export function editsFor() {
  return [
    {
      name: 'schema accepts the attachment ref',
      from: `          text: { type: 'string', required: true },
          image: { type: 'string' },`,
      to: `          text: { type: 'string', required: true },
          image: { type: 'string' },
          attachment: { type: 'object', additionalProperties: true },`,
    },
    {
      name: 'render emits a real attachment block',
      from: `      if (value.image) blocks.push({ type: 'image', data: value.image, mediaType: 'image/jpeg' })`,
      to: `      if (value.attachment) blocks.push({ type: 'image', attachment: value.attachment })`,
    },
    {
      name: 'save the screenshot before returning it',
      from: `        const gate = authorize ? action => authorize(exec, botId, action) : undefined
        return gateScope.run(gate, () => spec.execute(args ?? {}, {
          botId,
          profileDir: join(profileRoot, botId),
          session,
          complete: completeFor?.(exec),
        }))`,
      to: `        const gate = authorize ? action => authorize(exec, botId, action) : undefined
        const result = await gateScope.run(gate, () => spec.execute(args ?? {}, {
          botId,
          profileDir: join(profileRoot, botId),
          session,
          complete: completeFor?.(exec),
        }))
        return withScreenshotAttachment(result, ctx)`,
    },
    {
      name: 'add the attachment helper',
      from: `/**
 * @param {any} ctx
 * @param {{ toolDefs: any[]`,
      to: `// ${MARKER} — DSH renders an image block only when it carries a real
// attachment reference (attachment.attachmentId); a bare base64 \`data\` field
// makes the image pipeline throw. Save the screenshot through the attachments
// service and hand the reference to render().
async function withScreenshotAttachment(value, ctx) {
  if (!value || typeof value !== 'object' || typeof value.image !== 'string' || value.image === '') return value
  try {
    const attachments = ctx?.get?.('attachments') ?? ctx?.attachments
    if (attachments && typeof attachments.saveImages === 'function') {
      const [ref] = await attachments.saveImages([{
        mediaType: 'image/jpeg',
        data: Buffer.from(value.image, 'base64'),
        name: 'Browser screenshot',
      }])
      if (ref) return { text: value.text, attachment: ref }
    }
  } catch { /* fall through to text only */ }
  return { text: value.text }
}

/**
 * @param {any} ctx
 * @param {{ toolDefs: any[]`,
    },
  ]
}

/**
 * Apply every edit to a source string.
 * @param {string} source
 * @returns {{source: string, changed: boolean, applied: string[], missing: string[], patched: boolean}}
 */
export function applyImagePatch(source) {
  const text = String(source ?? '')
  if (text.includes(MARKER)) {
    return { source: text, changed: false, applied: [], missing: [], patched: true }
  }
  let next = text
  const applied = []
  const missing = []
  for (const edit of editsFor()) {
    if (!next.includes(edit.from)) { missing.push(edit.name); continue }
    next = next.replace(edit.from, edit.to)
    applied.push(edit.name)
  }
  return { source: next, changed: applied.length > 0 && missing.length === 0, applied, missing, patched: false }
}

/**
 * Guard the image pipeline against an image block with no attachment.
 *
 * `withImagesAsText` reads `block.attachment.attachmentId` unconditionally. A
 * message already stored with the old `{ type: 'image', data }` shape therefore
 * throws on *every* later turn of that session — the session looks permanently
 * broken ("插件缓存的会话是坏的") even after the producer is fixed. Skipping the
 * block instead of crashing keeps old history readable.
 *
 * @param {string} source images.js
 * @returns {{source: string, changed: boolean, applied: string[], missing: string[], patched: boolean}}
 */
export function applyHistoryGuardPatch(source) {
  const text = String(source ?? '')
  if (text.includes(HISTORY_MARKER)) {
    return { source: text, changed: false, applied: [], missing: [], patched: true }
  }
  const edits = [
    {
      name: 'collect only blocks that carry an attachment',
      from: `        if (block?.type === 'image' && !block.offloaded) images.set(String(block.attachment.attachmentId), block.attachment)`,
      to: `        // ${HISTORY_MARKER}: an image block without a stored attachment is
        // stale data (an older screenshot format); skip it instead of throwing.
        if (block?.type === 'image' && block.attachment && !block.offloaded) images.set(String(block.attachment.attachmentId), block.attachment)`,
    },
    {
      name: 'map only blocks that carry an attachment',
      from: `          content: message.content.map(block => (block?.type === 'image' && !block.offloaded`,
      to: `          content: message.content.map(block => (block?.type === 'image' && block.attachment && !block.offloaded`,
    },
  ]
  let next = text
  const applied = []
  const missing = []
  for (const edit of edits) {
    if (!next.includes(edit.from)) { missing.push(edit.name); continue }
    next = next.replace(edit.from, edit.to)
    applied.push(edit.name)
  }
  return { source: next, changed: applied.length > 0 && missing.length === 0, applied, missing, patched: false }
}

/** Minimal argv parser: --key value, --flag, --key=value. */
export function parseArgs(argv) {
  const out = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) { out._.push(token); continue }
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq !== -1) { out[body.slice(0, eq)] = body.slice(eq + 1); continue }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) { out[body] = next; index += 1 } else { out[body] = true }
  }
  return out
}

/** Where ds-bot normally lives for the web profile. */
export function defaultDsBotDir(env = process.env) {
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'profiles', 'web', 'node_modules', 'ds-bot')
}

/** Patch one file with one patcher, honouring --dry-run / --revert. */
function patchFile({ file, patcher, dryRun, revert }) {
  const backup = `${file}.pre-dsbot-image`
  if (!existsSync(file)) {
    console.error(`ds-bot file not found: ${file}`)
    return 2
  }
  if (revert) {
    if (!existsSync(backup)) { console.error(`no backup to restore: ${backup}`); return 2 }
    copyFileSync(backup, file)
    console.log(`restored ${file}`)
    return 0
  }

  const result = patcher(readFileSync(file, 'utf8'))
  if (result.patched) { console.log(`already patched: ${file}`); return 0 }
  if (result.missing.length > 0) {
    console.error(`ds-bot source does not match this patch (version drift): ${file}`)
    for (const name of result.missing) console.error(`  missing anchor: ${name}`)
    console.error('Nothing was written for this file.')
    return 1
  }
  for (const name of result.applied) console.log(`  edit: ${name}`)
  if (dryRun) { console.log(`would write ${file}`); return 0 }

  if (!existsSync(backup)) copyFileSync(file, backup)
  writeFileSync(file, result.source)

  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (check.status !== 0) {
    copyFileSync(backup, file)
    console.error(`syntax check failed, restored ${file}:`)
    console.error(check.stderr ?? '')
    return 1
  }
  console.log(`patched ${file}`)
  return 0
}

function main(argv) {
  const args = parseArgs(argv)
  const target = resolve(typeof args.path === 'string' ? args.path : defaultDsBotDir())
  const dryRun = Boolean(args['dry-run'])
  const revert = Boolean(args.revert)

  const jobs = [
    { file: join(target, RELATIVE), patcher: applyImagePatch, title: 'screenshot -> attachment' },
    { file: join(target, IMAGES_RELATIVE), patcher: applyHistoryGuardPatch, title: 'tolerate stale image blocks' },
  ]

  let code = 0
  for (const job of jobs) {
    console.log(`\n== ${job.title}`)
    const result = patchFile({ file: job.file, patcher: job.patcher, dryRun, revert })
    if (result !== 0) code = result
  }
  if (code === 0 && !dryRun && !revert) {
    console.log('\nRestart the DSH web service so the new modules are loaded.')
  }
  return code
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
