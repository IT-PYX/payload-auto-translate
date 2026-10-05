#!/usr/bin/env node

import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { DatabaseCrawler } from './database-crawler'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Dynamic environment loading
try {
  const dotenv = await import('dotenv')
  const envArg = process.argv.find((a) => a.startsWith('--env='))?.split('=')[1]
  const candidatePaths = [
    envArg,
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), 'apps/cms/.env'),
    path.resolve(__dirname, '../../../../.env'),
    path.resolve(__dirname, '../../../.env'),
  ].filter(Boolean) as string[]

  let loaded = false
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p })
      loaded = true
      break
    }
  }
  if (!loaded) {
    dotenv.config?.()
  }
} catch {}

async function main() {
  const isLive = process.argv.includes('--live')
  const tablesArg = process.argv.find((arg) => arg.startsWith('--tables='))
  const onlyTables = tablesArg
    ? tablesArg.split('=')[1].split(',').map((t) => t.trim())
    : undefined

  const engineUrl = process.env.LIBRETRANSLATE_URL || 'http://127.0.0.1:5000'
  const sourceLocale = process.env.SOURCE_LOCALE || 'en'
  const targetLocales = process.env.TARGET_LOCALES
    ? process.env.TARGET_LOCALES.split(',').map((s) => s.trim())
    : ['es', 'fr', 'ar', 'pt', 'de', 'ru', 'ja', 'it']

  const fallbackRetryEnabled =
    process.argv.includes('--fallback-retry') ||
    process.env.AUTO_TRANSLATE_FALLBACK_RETRY === 'true' ||
    process.env.AUTO_TRANSLATE_FALLBACK_RETRY === '1'

  const fallbackStrategyArg = process.argv.find((arg) => arg.startsWith('--fallback-strategy='))?.split('=')[1]
  const fallbackStrategy =
    (fallbackStrategyArg as 'sentence-case' | 'lower-case') ||
    (process.env.AUTO_TRANSLATE_FALLBACK_STRATEGY as 'sentence-case' | 'lower-case') ||
    'sentence-case'

  const patternsArg = process.argv.find((arg) => arg.startsWith('--value-patterns='))?.split('=')[1]
  const envPatterns = process.env.AUTO_TRANSLATE_VALUE_PATTERNS
  const rawPatterns = (patternsArg || envPatterns || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const customValuePatterns = rawPatterns.map((pat) => {
    const regexMatch = pat.match(/^\/(.+)\/([a-z]*)$/)
    if (regexMatch) {
      try {
        return new RegExp(regexMatch[1], regexMatch[2])
      } catch {}
    }
    return pat
  })

  const exclusionsArg = process.argv.find((arg) => arg.startsWith('--value-exclusions='))?.split('=')[1]
  const envExclusions = process.env.AUTO_TRANSLATE_VALUE_EXCLUSIONS
  const customValueExclusions = (exclusionsArg || envExclusions || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  console.log(`\n=============================================================`)
  console.log(`🚀 PAYLOAD AUTO-TRANSLATE BULK CRAWLER`)
  console.log(`Engine: ${engineUrl}`)
  console.log(`Mode: ${isLive ? '🔴 LIVE (Writing to Database)' : '🟢 DRY-RUN (Plan Only - No DB writes)'}`)
  console.log(`Source: ${sourceLocale} -> Targets: [${targetLocales.join(', ')}]`)
  if (onlyTables) {
    console.log(`Tables: [${onlyTables.join(', ')}]`)
  }
  if (fallbackRetryEnabled) {
    console.log(`Fallback Retry: Enabled (strategy: ${fallbackStrategy})`)
  }
  if (customValuePatterns.length > 0) {
    console.log(`Value Patterns: [${rawPatterns.join(', ')}]`)
  }
  if (customValueExclusions.length > 0) {
    console.log(`Value Exclusions: [${customValueExclusions.join(', ')}]`)
  }
  console.log(`=============================================================\n`)

  const apiKey = process.env.LIBRETRANSLATE_API_KEY

  const crawler = new DatabaseCrawler({
    engineUrl,
    apiKey,
    sourceLocale,
    targetLocales,
    isLive,
    onlyTables,
    customValueExclusions: customValueExclusions.length > 0 ? customValueExclusions : undefined,
    customValuePatterns: customValuePatterns.length > 0 ? customValuePatterns : undefined,
    fallbackRetry: fallbackRetryEnabled ? { enabled: true, strategy: fallbackStrategy } : undefined,
  })

  const res = await crawler.run()
  console.log(`\nSummary:`)
  console.log(`- Total tables: ${res.totalTables}`)
  console.log(`- Translated strings: ${res.translatedStrings}`)
  console.log(`- Failed strings (or echoes): ${res.failedStrings || 0}`)
  console.log(`- Inserted rows: ${res.insertedRows}`)
  console.log(`- Updated rows: ${res.updatedRows}`)
  console.log(`- Skipped rows: ${res.skippedRows}`)
  console.log(`- Status: ${res.status}\n`)
}

main().catch((err) => {
  console.error('[auto-translate] Fatal error:', err)
  process.exit(1)
})
