import { decodeHtmlEntities } from './filter'
import type { FallbackRetryOptions } from '../types'

const SCRIPT_PATTERNS: Record<string, RegExp> = {
  ar: /[\u0600-\u06FF\u0750-\u077F]/,
  ru: /[\u0400-\u04FF]/,
  ja: /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF]/,
}

function isTitleCaseHeadline(text: string): boolean {
  if (!text || text.length < 8 || !text.includes(' ')) return false
  const words = text.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w))
  if (words.length < 2) return false
  const capitalized = words.filter((w) => /^[A-Z]/.test(w))
  return capitalized.length / words.length >= 0.6
}

function toSentenceCase(text: string): string {
  if (!text) return ''
  const trimmed = text.trim()
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase()
}

/**
 * Detects translations that came back as (near-)identical source text.
 * LibreTranslate occasionally echoes English — sometimes with a case change — for
 * certain short/technical strings. Writing those as "translations" silently poisons
 * localized rows, so they are treated as failures and the original is preserved
 * (the crawler re-detects and retries them on the next run).
 */
function looksUntranslated(val: unknown, orig: string, targetLocale: string): boolean {
  if (typeof val !== 'string' || !val.trim()) return true
  if (val === orig) return true
  const script = SCRIPT_PATTERNS[targetLocale]
  if (script && !script.test(val) && /[A-Za-z]{3,}/.test(val)) return true
  return false
}

export async function checkLibreTranslateHealth(
  baseUrl = 'http://127.0.0.1:5000',
  apiKey?: string,
): Promise<{ ok: boolean; languages: string[]; error?: string }> {
  try {
    const headers: Record<string, string> = {
      Connection: 'keep-alive',
    }
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    const res = await fetch(`${baseUrl}/languages`, {
      signal: AbortSignal.timeout(20000),
      headers,
    })
    if (!res.ok) {
      return { ok: false, languages: [], error: `HTTP ${res.status}` }
    }
    const list: any = await res.json()
    const codes = Array.isArray(list) ? list.map((l: any) => l.code) : []
    return { ok: true, languages: codes }
  } catch (err: any) {
    return { ok: false, languages: [], error: err.message }
  }
}

/**
 * Translates a single text string using LibreTranslate with retry logic
 */
export async function translateSingleText(
  text: string,
  targetLocale: string,
  sourceLocale = 'en',
  baseUrl = 'http://127.0.0.1:5000',
  apiKey?: string,
  maxRetries = 3,
): Promise<string> {
  if (!text || !text.trim()) return text

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Connection: 'keep-alive',
  }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/translate`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(25000),
        body: JSON.stringify({
          q: text,
          source: sourceLocale,
          target: targetLocale,
          format: text.includes('<') ? 'html' : 'text',
          ...(apiKey ? { api_key: apiKey } : {}),
        }),
      })

      if (!res.ok) {
        throw new Error(`LibreTranslate error HTTP ${res.status}: ${await res.text()}`)
      }

      const data: any = await res.json()
      const translated = Array.isArray(data.translatedText)
        ? data.translatedText[0]
        : data.translatedText

      if (looksUntranslated(translated, text, targetLocale)) {
        throw new Error('Translation came back as source echo')
      }

      return decodeHtmlEntities(translated || text)
    } catch (err: any) {
      if (attempt === maxRetries) {
        console.warn(`[auto-translate] Failed translating string after ${maxRetries} attempts: ${err.message}`)
        return text
      }
      await new Promise((r) => setTimeout(r, attempt * 1000))
    }
  }

  return text
}

/**
 * Translates an array of distinct strings in chunks with persistent keep-alive and retry.
 * Chunks are bounded by both string count and total characters, and a failed chunk
 * falls back to per-string requests so one oversized string cannot sink the whole chunk.
 */
export async function translateBatchViaLibre(
  strings: string[],
  targetLocale: string,
  sourceLocale = 'en',
  baseUrl = 'http://127.0.0.1:5000',
  apiKey?: string,
  chunkSize = 15,
  maxRetries = 3,
  onChunk?: (succeededCount: number, failedCount: number) => void,
  fallbackRetry?: FallbackRetryOptions,
): Promise<Map<string, string>> {
  const translationMap = new Map<string, string>()
  if (strings.length === 0) return translationMap

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Connection: 'keep-alive',
  }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const MAX_CHUNK_CHARS = 6000

  const attemptChunk = async (chunk: string[]): Promise<string[] | null> => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(`${baseUrl}/translate`, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(60000),
          body: JSON.stringify({
            q: chunk,
            source: sourceLocale,
            target: targetLocale,
            format: 'text',
            ...(apiKey ? { api_key: apiKey } : {}),
          }),
        })

        if (res.ok) {
          const data: any = await res.json()
          const arr = Array.isArray(data.translatedText) ? data.translatedText : [data.translatedText]
          if (arr.length === chunk.length) {
            return arr.map((t: any) => decodeHtmlEntities(t ?? ''))
          }
          console.warn(
            `[auto-translate] Chunk response length mismatch (${arr.length} != ${chunk.length}), retrying...`,
          )
        } else {
          const errText = await res.text()
          console.warn(`[auto-translate] Attempt ${attempt}/${maxRetries} returned HTTP ${res.status}: ${errText}`)
        }
      } catch (err: any) {
        console.warn(`[auto-translate] Attempt ${attempt}/${maxRetries} error: ${err.message}`)
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, attempt * 2000))
      }
    }
    return null
  }

  // Build chunks bounded by string count AND cumulative characters
  const chunks: string[][] = []
  let cur: string[] = []
  let curChars = 0
  for (const s of strings) {
    const len = s.length
    if (len > MAX_CHUNK_CHARS) {
      if (cur.length) {
        chunks.push(cur)
        cur = []
        curChars = 0
      }
      chunks.push([s])
      continue
    }
    if (cur.length >= chunkSize || curChars + len > MAX_CHUNK_CHARS) {
      chunks.push(cur)
      cur = []
      curChars = 0
    }
    cur.push(s)
    curChars += len
  }
  if (cur.length) chunks.push(cur)

  for (const chunk of chunks) {
    const translated = await attemptChunk(chunk)

    if (translated) {
      let flagged = 0
      const retryCandidates: { orig: string; transformed: string }[] = []

      chunk.forEach((orig, idx) => {
        if (looksUntranslated(translated[idx], orig, targetLocale)) {
          if (fallbackRetry?.enabled && isTitleCaseHeadline(orig)) {
            const transformed =
              fallbackRetry.strategy === 'lower-case' ? orig.toLowerCase() : toSentenceCase(orig)
            retryCandidates.push({ orig, transformed })
          } else {
            translationMap.set(orig, orig)
            flagged++
          }
        } else {
          translationMap.set(orig, translated[idx])
        }
      })

      // Attempt fallback retry on Title Case echo candidates
      if (retryCandidates.length > 0) {
        const transformedList = retryCandidates.map((c) => c.transformed)
        const retryResults = await attemptChunk(transformedList)
        if (retryResults && retryResults.length === retryCandidates.length) {
          retryCandidates.forEach((c, i) => {
            const res = retryResults[i]
            if (res && !looksUntranslated(res, c.transformed, targetLocale)) {
              translationMap.set(c.orig, res)
            } else {
              translationMap.set(c.orig, c.orig)
              flagged++
            }
          })
        } else {
          for (const c of retryCandidates) {
            const one = await attemptChunk([c.transformed])
            if (one && !looksUntranslated(one[0], c.transformed, targetLocale)) {
              translationMap.set(c.orig, one[0])
            } else {
              translationMap.set(c.orig, c.orig)
              flagged++
            }
          }
        }
      }

      if (onChunk) onChunk(chunk.length - flagged, flagged)
      if (flagged > 0) {
        console.warn(`[auto-translate] ${flagged}/${chunk.length} strings came back untranslated (source echo)`)
      }
      continue
    }

    // Chunk failed after retries — fall back to per-string requests
    console.warn(
      `[auto-translate] Chunk of ${chunk.length} strings failed, falling back to per-string requests...`,
    )
    let failed = 0
    for (const s of chunk) {
      const one = await attemptChunk([s])
      if (one && !looksUntranslated(one[0], s, targetLocale)) {
        translationMap.set(s, one[0])
      } else if (fallbackRetry?.enabled && isTitleCaseHeadline(s)) {
        const transformed =
          fallbackRetry.strategy === 'lower-case' ? s.toLowerCase() : toSentenceCase(s)
        const retryOne = await attemptChunk([transformed])
        if (retryOne && !looksUntranslated(retryOne[0], transformed, targetLocale)) {
          translationMap.set(s, retryOne[0])
        } else {
          translationMap.set(s, s)
          failed++
        }
      } else {
        translationMap.set(s, s)
        failed++
      }
    }
    if (onChunk) onChunk(chunk.length - failed, failed)
    if (failed > 0) {
      console.error(`[auto-translate] ${failed} strings failed even after per-string fallback. Preserving originals.`)
    }
  }

  return translationMap
}

/**
 * Translates a key-value dictionary { t_0: "Hello", t_1: "World" }
 */
export async function translateJsonObjectViaLibre(
  obj: Record<string, string>,
  targetLocale: string,
  sourceLocale = 'en',
  baseUrl = 'http://127.0.0.1:5000',
  apiKey?: string,
): Promise<Record<string, string>> {
  const keys = Object.keys(obj)
  if (keys.length === 0) return {}

  const translatableEntries: { key: string; value: string }[] = []
  const result: Record<string, string> = { ...obj }

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && value.trim()) {
      translatableEntries.push({ key, value })
    }
  }

  if (translatableEntries.length === 0) return result

  const values = translatableEntries.map((e) => e.value)
  const map = await translateBatchViaLibre(values, targetLocale, sourceLocale, baseUrl, apiKey)

  translatableEntries.forEach((entry) => {
    const trans = map.get(entry.value)
    if (trans) {
      result[entry.key] = trans
    }
  })

  return result
}
