import { memoryAdapter } from '../packages/better-newsletter/src/adapters/memory.js'
import { registerConfirmationExpiryConformance } from './storage-conformance.js'

let storage = memoryAdapter()
registerConfirmationExpiryConformance({
  name: 'Memory',
  async reset() { storage = memoryAdapter() },
  createStorage: () => storage
})
