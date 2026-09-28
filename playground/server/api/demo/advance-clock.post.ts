import { advanceDemoClock } from '../../utils/demo-state'

export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 })
  const body = await readBody(event)
  if (body?.milliseconds !== 11_000 && body?.milliseconds !== 6 * 60_000) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid demo clock step.' })
  }
  return { offsetMs: advanceDemoClock(body.milliseconds) }
})
