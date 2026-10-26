/* The upstream-coupling guard.
 *
 * DSH's Web UI ships CSS-module class names that are rebuilt on every
 * frontend release ("wSkVaW_composerStack", "uV2eYG_root"). A rule that
 * targets one of them breaks silently on the next upstream build: the shell
 * loses its layout but nothing reports an error.
 *
 * The shell addresses the host through the documented surfaces instead:
 *
 *   - [data-slot="..."]  the slot vocabulary DSH publishes (105 slots)
 *   - [data-chat-running], [data-composer-card], [data-composer-input]
 *                        the host's own semantic markers
 *
 * This test keeps the private class names out of the stylesheet, so a future
 * edit cannot quietly reintroduce the coupling.
 */
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/* A CSS-module class: short camel-case prefix, underscore, hashed tail. */
const MODULE_CLASS = /\.[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_-]+/g

test('the stylesheet targets no upstream-private class names', () => {
  for (const file of ['pwa/app.css']) {
    const text = read(file)
    const found = (text.match(MODULE_CLASS) || []).filter((hit) => {
      // Our own names use hyphens, never an underscore, so every hit here is
      // an upstream build artefact.
      return !hit.startsWith('.dsh-')
    })
    assert.deepStrictEqual(
      found, [],
      file + ' still targets upstream-private class names: ' + found.join(', ')
    )
  }
})

test('the stylesheet uses the published slot vocabulary', () => {
  const css = read('pwa/app.css')
  const slots = new Set()
  const re = /\[data-slot="([^"]+)"\]/g
  let m
  while ((m = re.exec(css)) !== null) slots.add(m[1])
  assert.ok(slots.size > 0, 'the stylesheet should address the host by slot')
  assert.ok(
    slots.has('conversation.composer.bar'),
    'the composer stack is addressed through the slot it holds'
  )
})

test('the shell scripts avoid upstream-private class names too', () => {
  for (const file of ['pwa/inject.js', 'pwa/muse-shell.js', 'pwa/touch-gestures.js']) {
    const text = read(file)
    const found = (text.match(MODULE_CLASS) || []).filter((hit) => !hit.startsWith('.dsh-'))
    assert.deepStrictEqual(
      found, [],
      file + ' still references upstream-private class names: ' + found.join(', ')
    )
  }
})
