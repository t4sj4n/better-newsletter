import process from 'node:process'
import { runReleaseCli } from './release-cli.mjs'

await runReleaseCli('prepare')
// Match release-it's CLI boundary; exit before rejected spinner promises can surface again.
if (process.exitCode) process.exit(process.exitCode)
