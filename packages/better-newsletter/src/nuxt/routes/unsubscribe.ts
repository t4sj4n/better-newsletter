import { defineEventHandler } from 'h3'
import options from '#better-newsletter-options'
import { handleNewsletterRequest } from '../handler.js'

export default defineEventHandler(event => handleNewsletterRequest(event, 'unsubscribe', options))
