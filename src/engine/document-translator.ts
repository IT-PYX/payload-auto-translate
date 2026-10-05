import { isTranslatableField, shouldSkipValue } from './filter'
import { isLexicalNode, extractLexicalTextNodes } from './lexical-compressor'
import { translateBatchViaLibre } from './libretranslate'
import type { FallbackRetryOptions } from '../types'

/**
 * Extracts all distinct translatable strings from an arbitrary document object
 * (including plain strings, nested groups, blocks, arrays, and Lexical AST leaves).
 */
export function extractTranslatableStrings(
  obj: any,
  excludedFields: Set<string> = new Set(),
  strings: Set<string> = new Set(),
  allowSlug = false,
  customValueExclusions?: Set<string>,
  customValuePatterns?: (string | RegExp)[],
): Set<string> {
  if (!obj || typeof obj !== 'object') return strings

  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractTranslatableStrings(
        item,
        excludedFields,
        strings,
        allowSlug,
        customValueExclusions,
        customValuePatterns,
      )
    }
    return strings
  }

  // If this object is a Lexical rich text AST, extract its text leaves
  if (isLexicalNode(obj)) {
    const textMap = extractLexicalTextNodes(obj)
    for (const text of textMap.values()) {
      if (!shouldSkipValue(text, customValueExclusions, customValuePatterns)) {
        strings.add(text)
      }
    }
    return strings
  }

  // Iterate object fields
  for (const [key, value] of Object.entries(obj)) {
    if (!isTranslatableField(key, excludedFields, allowSlug)) continue

    if (typeof value === 'string') {
      if (!shouldSkipValue(value, customValueExclusions, customValuePatterns)) {
        strings.add(value)
      }
    } else if (typeof value === 'object' && value !== null) {
      extractTranslatableStrings(
        value,
        excludedFields,
        strings,
        allowSlug,
        customValueExclusions,
        customValuePatterns,
      )
    }
  }

  return strings
}

/**
 * Injects translated strings back into a document structure.
 */
export function applyTranslationsToDocument(
  obj: any,
  translationMap: Map<string, string>,
  excludedFields: Set<string> = new Set(),
  allowSlug = false,
  customValueExclusions?: Set<string>,
  customValuePatterns?: (string | RegExp)[],
): any {
  if (obj === null || obj === undefined) return obj

  if (typeof obj !== 'object') {
    if (typeof obj === 'string' && !shouldSkipValue(obj, customValueExclusions, customValuePatterns)) {
      return translationMap.get(obj) || obj
    }
    return obj
  }

  if (Array.isArray(obj)) {
    return obj.map((item) =>
      applyTranslationsToDocument(
        item,
        translationMap,
        excludedFields,
        allowSlug,
        customValueExclusions,
        customValuePatterns,
      ),
    )
  }

  // Handle Lexical rich text AST
  if (isLexicalNode(obj)) {
    return applyLexicalASTWithMap(obj, translationMap, customValueExclusions, customValuePatterns)
  }

  // Handle plain objects, blocks, groups
  const result: Record<string, any> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (!isTranslatableField(key, excludedFields, allowSlug)) {
      result[key] = value
      continue
    }

    if (typeof value === 'string') {
      if (!shouldSkipValue(value, customValueExclusions, customValuePatterns)) {
        result[key] = translationMap.get(value) || value
      } else {
        result[key] = value
      }
    } else if (typeof value === 'object' && value !== null) {
      result[key] = applyTranslationsToDocument(
        value,
        translationMap,
        excludedFields,
        allowSlug,
        customValueExclusions,
        customValuePatterns,
      )
    } else {
      result[key] = value
    }
  }

  return result
}

function applyLexicalASTWithMap(
  node: any,
  translationMap: Map<string, string>,
  customValueExclusions?: Set<string>,
  customValuePatterns?: (string | RegExp)[],
): any {
  if (Array.isArray(node)) {
    return node.map((item) =>
      applyLexicalASTWithMap(item, translationMap, customValueExclusions, customValuePatterns),
    )
  } else if (node && typeof node === 'object') {
    const copy: any = { ...node }
    if (
      copy.type === 'text' &&
      typeof copy.text === 'string' &&
      copy.text.trim() &&
      !shouldSkipValue(copy.text, customValueExclusions, customValuePatterns)
    ) {
      const translated = translationMap.get(copy.text)
      if (translated) {
        copy.text = translated
      }
    }
    for (const k of Object.keys(copy)) {
      copy[k] = applyLexicalASTWithMap(
        copy[k],
        translationMap,
        customValueExclusions,
        customValuePatterns,
      )
    }
    return copy
  }
  return node
}

/**
 * Checks whether a value at the target locale is "empty" (not yet translated).
 * Returns true if the field should receive a new translation.
 */
function isValueEmpty(val: any): boolean {
  if (val === null || val === undefined) return true
  if (typeof val === 'string' && val.trim() === '') return true
  if (Array.isArray(val) && val.length === 0) return true
  return false
}

/**
 * Recursively merges translated values into existingDoc,
 * but ONLY where existingDoc has empty/null/undefined values.
 * Preserves existing human translations, arrays, and blocks.
 */
function getBaseId(item: any): string | null {
  if (!item || typeof item !== 'object' || !item.id) return null
  return String(item.id).replace(/(_[a-z]{2}(-[A-Z]{2})?)+$/, '')
}

function mergeArraysPreservingExisting(translated: any[], existing: any[]): any[] {
  if (!Array.isArray(existing) || existing.length === 0) return translated
  if (!Array.isArray(translated) || translated.length === 0) return existing

  // Scalar arrays (strings, numbers) — preserve existing if present
  if (typeof translated[0] !== 'object' || translated[0] === null) {
    return existing
  }

  const availableExisting = [...existing]
  const usedIndices = new Set<number>()
  const result: any[] = []

  for (let i = 0; i < translated.length; i++) {
    const tItem = translated[i]
    if (!tItem || typeof tItem !== 'object') {
      result.push(tItem)
      continue
    }

    const tBaseId = getBaseId(tItem)
    const tBlockType = tItem.blockType
    let matchIdx = -1

    // 1. Try matching by base ID (handles reordered blocks / array items)
    if (tBaseId) {
      matchIdx = availableExisting.findIndex((eItem, idx) => {
        if (usedIndices.has(idx)) return false
        return getBaseId(eItem) === tBaseId
      })
    }

    // 2. Fallback: match by identical blockType (if blocks) or positional index (if plain array items)
    if (matchIdx === -1) {
      if (tBlockType) {
        if (
          i < availableExisting.length &&
          !usedIndices.has(i) &&
          availableExisting[i]?.blockType === tBlockType
        ) {
          matchIdx = i
        } else {
          matchIdx = availableExisting.findIndex(
            (eItem, idx) => !usedIndices.has(idx) && eItem?.blockType === tBlockType,
          )
        }
      } else {
        // Simple array item (e.g. items without blockType)
        if (i < availableExisting.length && !usedIndices.has(i) && !availableExisting[i]?.blockType) {
          matchIdx = i
        }
      }
    }

    if (matchIdx !== -1) {
      usedIndices.add(matchIdx)
      result.push(mergePreservingExisting(tItem, availableExisting[matchIdx]))
    } else {
      // Newly added source block: use translated version
      result.push(tItem)
    }
  }

  return result
}

/**
 * Recursively merges translated values into existingDoc,
 * but ONLY where existingDoc has empty/null/undefined values.
 * Preserves existing human translations, while updating blocks intelligently.
 */
export function mergePreservingExisting(
  translated: any,
  existing: any,
): any {
  if (translated === null || translated === undefined) return translated
  if (existing === null || existing === undefined) return translated
  if (typeof translated !== 'object' || typeof existing !== 'object') {
    // Scalar — use translated only if existing is empty
    return isValueEmpty(existing) ? translated : existing
  }

  // Arrays — merge item-by-item preserving existing while adding new items
  if (Array.isArray(translated)) {
    if (Array.isArray(existing)) {
      return mergeArraysPreservingExisting(translated, existing)
    }
    return translated
  }

  // Objects — merge field by field
  if (Array.isArray(existing)) {
    // existing is array but translated is not — shouldn't happen, but be safe
    return translated
  }

  const result: Record<string, any> = {}
  const allKeys = new Set([...Object.keys(translated), ...Object.keys(existing)])

  for (const key of allKeys) {
    const tVal = translated[key]
    const eVal = existing[key]

    // Non-translatable keys (blockType, id, etc.) — always take from translated
    if (!isTranslatableField(key)) {
      result[key] = tVal !== undefined ? tVal : eVal
      continue
    }

    // If existing is empty, take translated
    if (isValueEmpty(eVal)) {
      result[key] = tVal
    } else if (
      typeof tVal === 'object' &&
      typeof eVal === 'object' &&
      tVal !== null &&
      eVal !== null
    ) {
      // Both are objects — recurse
      result[key] = mergePreservingExisting(tVal, eVal)
    } else {
      // Existing has a value — preserve it
      result[key] = eVal
    }
  }

  return result
}

/**
 * Translates a complete document into a target locale in a single high-speed batch operation.
 */
export async function translateDocument(
  doc: Record<string, any>,
  targetLocale: string,
  sourceLocale = 'en',
  engineUrl = 'http://127.0.0.1:5000',
  apiKey?: string,
  excludedFields: string[] = [],
  allowSlug = false,
  customValueExclusions?: string[],
  customValuePatterns?: (string | RegExp)[],
  fallbackRetry?: FallbackRetryOptions,
): Promise<Record<string, any>> {
  const excludedSet = new Set(excludedFields)
  const valExclusionsSet = customValueExclusions ? new Set(customValueExclusions) : undefined

  // 1. Collect all distinct strings across the document
  const stringSet = extractTranslatableStrings(
    doc,
    excludedSet,
    new Set(),
    allowSlug,
    valExclusionsSet,
    customValuePatterns,
  )
  const distinctStrings = Array.from(stringSet)

  if (distinctStrings.length === 0) {
    return doc
  }

  // 2. Batch translate all distinct strings in one go
  const translationMap = await translateBatchViaLibre(
    distinctStrings,
    targetLocale,
    sourceLocale,
    engineUrl,
    apiKey,
    15,
    3,
    undefined,
    fallbackRetry,
  )

  // 3. Re-inject translated values into document clone
  return applyTranslationsToDocument(
    doc,
    translationMap,
    excludedSet,
    allowSlug,
    valExclusionsSet,
    customValuePatterns,
  )
}
