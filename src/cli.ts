#!/usr/bin/env node
import process from 'node:process'
import { runBetterNewsletterCli } from './cli/run.js'

process.exitCode = await runBetterNewsletterCli(process.argv.slice(2))
