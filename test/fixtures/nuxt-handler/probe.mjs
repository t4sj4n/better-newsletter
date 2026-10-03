import process from 'node:process'
import console from 'node:console'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout } from 'node:timers/promises'

const reservation = createServer()
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const child = spawn(process.execPath, ['.output/server/index.mjs'], {
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: 'inherit'
})
const base = `http://127.0.0.1:${port}`
async function request(path, body, status = 200, method = 'POST') {
  const response = await globalThis.fetch(`${base}${path}`, {
    method, ...(method === 'POST' ? {
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    } : {})
  })
  assert.equal(response.status, status, path)
  return response.json()
}
try {
  let ready = false
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode != null) throw new Error('Nuxt server exited before readiness')
    try { await globalThis.fetch(base); ready = true; break } catch { await setTimeout(100) }
  }
  assert.ok(ready, 'Nuxt server started')
  const input = {
    email: 'packed@example.com', consent: true, consentVersion: 'packed-v1',
    audiences: ['default', 'product'], placement: 'pricing', captcha: 'verified',
    metadata: { forged: true }
  }
  assert.deepEqual(await request('/api/mail/subscribe', { ...input, website: 'bot' }), { accepted: true })
  assert.deepEqual(await request('/api/mail/subscribe', { ...input, captcha: 'invalid' }), { accepted: true })
  let host = await request('/api/smoke', {})
  assert.equal(host.contact, null)
  assert.equal(host.tokens.length, 0)
  assert.deepEqual(await request('/api/mail/subscribe', input), { accepted: true })
  host = await request('/api/smoke', {})
  assert.equal(host.tokens.length, 2, 'delivery awaited before responding')
  assert.equal(host.contact.metadata, undefined)
  const signups = host.events.filter(event => event.type === 'SIGNED_UP')
  assert.equal(signups.length, 2)
  for (const event of signups) {
    assert.equal(event.metadata.placement, 'pricing')
    assert.equal(event.metadata.forged, undefined)
    assert.equal(event.metadata.captcha, undefined)
  }
  assert.ok(host.securityCalls > 0)
  assert.ok(host.identities > 0)
  assert.deepEqual(await request('/api/mail/resend-confirmation', {
    email: 'missing@example.com', captcha: 'verified'
  }), { accepted: true })
  for (const token of host.tokens) assert.deepEqual(await request('/api/mail/confirm', { token }), { confirmed: true })
  await request('/api/mail/confirm', {}, 405, 'GET')
  await request('/api/mail/unknown', {}, 404)
  await request('/api/mail/preferences', { capability: host.manage }, 404)
  assert.equal((await request('/api/mail/manage', { capability: host.manage })).subscriptions.length, 2)
  await request('/api/mail/unsubscribe', { capability: host.unsubscribe })
  await request('/api/mail/unsubscribe-all', { capability: host.all })
  host = await request('/api/smoke', {})
  assert.equal((await request('/api/mail/manage', { capability: host.manage })).subscriptions
    .every(subscription => subscription.status === 'UNSUBSCRIBED'), true)
  await request('/api/mail/subscribe', input)
  host = await request('/api/smoke', { disable: true })
  const resubscribes = host.events.filter(event => event.type === 'RESUBSCRIBED')
  assert.equal(resubscribes.length, 2)
  assert.ok(resubscribes.every(event => event.metadata.placement === 'pricing'))
  await request('/api/mail/manage', { capability: host.manage }, 404)
  console.log('Packed Nuxt handler lifecycle, policy, server isolation and typed client checks passed')
} finally {
  child.kill('SIGTERM')
  await new Promise(resolve => { if (child.exitCode != null) resolve(); else child.once('exit', resolve) })
}
