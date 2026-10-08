export {
  defaultNewsletterCopy,
  mergeNewsletterCopy,
  type DeepPartial,
  type NewsletterCopy,
  type NewsletterCopyOverrides
} from './copy.js'

export {
  errorState,
  focusInvalid,
  useNewsletterRequest,
  validEmail,
  type NewsletterState
} from './utils/request.js'

export {
  useNewsletterClient
} from './composables/useNewsletterClient.js'

export {
  useNewsletterCopy,
  type NewsletterCopySource
} from './composables/useNewsletterCopy.js'

export {
  useNewsletterSignup,
  type UseNewsletterSignupOptions,
  type UseNewsletterSignupReturn
} from './composables/useNewsletterSignup.js'

export {
  useNewsletterConfirm,
  type UseNewsletterConfirmOptions,
  type UseNewsletterConfirmReturn
} from './composables/useNewsletterConfirm.js'

export {
  useNewsletterResend,
  type UseNewsletterResendOptions,
  type UseNewsletterResendReturn
} from './composables/useNewsletterResend.js'

export {
  useNewsletterUnsubscribe,
  type UseNewsletterUnsubscribeOptions,
  type UseNewsletterUnsubscribeReturn
} from './composables/useNewsletterUnsubscribe.js'

