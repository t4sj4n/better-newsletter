import type { Clock } from './config.js'
import type {
  CapabilityNonceRecord,
  CapabilityNonceStore,
  ConfirmationTokenRecord,
  ConfirmationTokenStore,
  RateLimiter
} from './security.js'

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class MemoryConfirmationTokenStore implements ConfirmationTokenStore {
  private readonly records = new Map<string, ConfirmationTokenRecord>()
  private queue: Promise<void> = Promise.resolve()

  private atomic<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(operation)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  replace(input: Parameters<ConfirmationTokenStore['replace']>[0]) {
    return this.atomic(() => {
      let replacedCount = 0
      let expiredCount = 0

      const active = [...this.records.values()]
        .filter(record =>
          record.subscriptionId === input.record.subscriptionId
          && record.consumedAt == null
          && record.revokedAt == null
        )
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())

      for (const record of active) {
        if (record.expiresAt.getTime() <= input.now.getTime()) {
          this.records.set(record.digest, {
            ...record,
            revokedAt: clone(input.now)
          })
          expiredCount += 1
        }
      }

      const unexpired = active.filter(
        record => record.expiresAt.getTime() > input.now.getTime()
      )

      if (input.strategy === 'REPLACE_PREVIOUS') {
        for (const record of unexpired) {
          this.records.set(record.digest, {
            ...record,
            revokedAt: clone(input.now)
          })
          replacedCount += 1
        }
      } else {
        const keepPrevious = Math.max(0, input.maxActiveTokens - 1)
        for (const record of unexpired.slice(keepPrevious)) {
          this.records.set(record.digest, {
            ...record,
            revokedAt: clone(input.now)
          })
          replacedCount += 1
        }
      }

      this.records.set(input.record.digest, clone(input.record))
      return { replacedCount, expiredCount }
    })
  }

  consume(input: Parameters<ConfirmationTokenStore['consume']>[0]) {
    return this.atomic(() => {
      const record = this.records.get(input.digest)
      if (
        record == null
        || record.consumedAt != null
        || record.revokedAt != null
      ) {
        return null
      }

      if (record.expiresAt.getTime() <= input.now.getTime()) {
        this.records.set(record.digest, {
          ...record,
          revokedAt: clone(input.now)
        })
        return null
      }

      const consumed = {
        ...record,
        consumedAt: clone(input.now)
      }
      this.records.set(record.digest, consumed)
      return clone(consumed)
    })
  }

  revokeBySubscription(
    input: Parameters<ConfirmationTokenStore['revokeBySubscription']>[0]
  ) {
    return this.atomic(() => {
      let count = 0
      for (const [digest, record] of this.records) {
        if (
          record.subscriptionId === input.subscriptionId
          && record.consumedAt == null
          && record.revokedAt == null
        ) {
          this.records.set(digest, {
            ...record,
            revokedAt: clone(input.now)
          })
          count += 1
        }
      }
      return count
    })
  }

  cleanup(input: Parameters<ConfirmationTokenStore['cleanup']>[0]) {
    return this.atomic(() => {
      let count = 0
      for (const [digest, record] of this.records) {
        const terminalAt = record.consumedAt
          ?? record.revokedAt
          ?? record.expiresAt

        if (terminalAt.getTime() <= input.deleteBefore.getTime()) {
          this.records.delete(digest)
          count += 1
        }
      }
      return count
    })
  }

  snapshot(): readonly ConfirmationTokenRecord[] {
    return [...this.records.values()].map(clone)
  }
}

export function memoryConfirmationTokenStore(): MemoryConfirmationTokenStore {
  return new MemoryConfirmationTokenStore()
}

export class MemoryCapabilityNonceStore implements CapabilityNonceStore {
  private readonly records = new Map<string, CapabilityNonceRecord>()

  private key(
    purpose: CapabilityNonceRecord['purpose'],
    targetId: string
  ): string {
    return `${purpose}\u0000${targetId}`
  }

  async get(
    purpose: CapabilityNonceRecord['purpose'],
    targetId: string
  ): Promise<CapabilityNonceRecord | null> {
    return clone(this.records.get(this.key(purpose, targetId)) ?? null)
  }

  async set(record: CapabilityNonceRecord): Promise<void> {
    this.records.set(
      this.key(record.purpose, record.targetId),
      clone(record)
    )
  }

  async delete(
    purpose: CapabilityNonceRecord['purpose'],
    targetId: string
  ): Promise<void> {
    this.records.delete(this.key(purpose, targetId))
  }

  snapshot(): readonly CapabilityNonceRecord[] {
    return [...this.records.values()].map(clone)
  }
}

export function memoryCapabilityNonceStore(): MemoryCapabilityNonceStore {
  return new MemoryCapabilityNonceStore()
}

interface RateLimitBucket {
  windowStartedAt: Date
  attempts: number
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>()
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly clock: Clock = { now: () => new Date() }) {}

  consume(input: Parameters<RateLimiter['consume']>[0]) {
    const run = this.queue.then(() => {
      const now = this.clock.now()
      const bucketKey = `${input.action}\u0000${input.key}`
      const previous = this.buckets.get(bucketKey)
      const windowExpired = previous == null
        || previous.windowStartedAt.getTime() + input.windowMs <= now.getTime()

      const bucket: RateLimitBucket = windowExpired
        ? { windowStartedAt: clone(now), attempts: 1 }
        : {
            windowStartedAt: previous.windowStartedAt,
            attempts: previous.attempts + 1
          }

      this.buckets.set(bucketKey, bucket)
      const allowed = bucket.attempts <= input.limit
      const retryAfterMs = Math.max(
        0,
        bucket.windowStartedAt.getTime() + input.windowMs - now.getTime()
      )
      return allowed
        ? { allowed: true as const }
        : { allowed: false as const, retryAfterMs }
    })

    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  snapshotKeys(): readonly string[] {
    return [...this.buckets.keys()]
  }
}

export function memoryRateLimiter(clock?: Clock): MemoryRateLimiter {
  return new MemoryRateLimiter(clock)
}
