import { describe, expect, it } from 'vitest'
import { decodeEventCursor, encodeEventCursor } from '../packages/better-newsletter/src/event-pagination.js'

describe('subscription event cursors', () => {
  it('round trips Unicode subscription IDs and exact bigint sequences', () => {
    const subscriptionId = 'subscription-ä-ニュース'
    const sequence = '9223372036854775807'
    expect(decodeEventCursor(encodeEventCursor(subscriptionId, sequence)))
      .toEqual({ subscriptionId, sequence })
  })

  it('rejects unsupported versions, invalid sequences, payload shapes, and noncanonical encodings', () => {
    for (const payload of [
      [2, 'subscription', '1'], [1, '', '1'], [1, 'subscription', 1],
      [1, 'subscription', '0'], [1, 'subscription', '-1'], [1, 'subscription', '01'],
      [1, 'subscription', '1.5'], [1, 'subscription', '1e3'],
      [1, 'subscription', '9223372036854775808'],
      [1, 'subscription', '1', 'extra'], { version: 1 }
    ]) {
      const cursor = Buffer.from(JSON.stringify(payload)).toString('base64url')
      expect(() => decodeEventCursor(cursor)).toThrowError(expect.objectContaining({ code: 'INVALID_PAGINATION' }))
    }
    for (const cursor of [
      encodeEventCursor('subscription', '1') + '=', 'a'.repeat(4097),
      Buffer.from([255]).toString('base64url'),
      Buffer.from(' [1,"subscription","1"]').toString('base64url')
    ]) {
      expect(() => decodeEventCursor(cursor)).toThrowError(expect.objectContaining({ code: 'INVALID_PAGINATION' }))
    }
  })
})
