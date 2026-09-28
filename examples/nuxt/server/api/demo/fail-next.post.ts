import { setNextFailure } from '../../utils/demo-state'

export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 })
  const body = await readBody(event)
  if (
    typeof body?.email !== 'string'
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(body.email)
    || !['default', 'product-news', 'weekly-analysis'].includes(body?.audience)
    || !['TEMPORARY', 'AMBIGUOUS'].includes(body?.failure)
  ) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid demo failure.' })
  }
  setNextFailure(body.email, body.audience, body.failure)
  return { ready: true }
})
