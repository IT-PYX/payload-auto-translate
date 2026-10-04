import { shouldSkipValue } from './filter'
import { translateJsonObjectViaLibre } from './libretranslate'

/**
 * Detects if an arbitrary value is a Lexical Rich Text AST
 */
export function isLexicalNode(val: unknown): boolean {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false
  const obj = val as Record<string, any>
  return (
    obj.root !== undefined &&
    typeof obj.root === 'object' &&
    obj.root !== null &&
    (obj.root.type === 'root' || Array.isArray(obj.root.children))
  )
}

/**
 * Recursively traverses a Lexical AST, extracting translatable text node strings
 */
export function extractLexicalTextNodes(
  node: any,
  map: Map<string, string> = new Map(),
): Map<string, string> {
  if (Array.isArray(node)) {
    for (const item of node) {
      extractLexicalTextNodes(item, map)
    }
  } else if (node && typeof node === 'object') {
    if (
      node.type === 'text' &&
      typeof node.text === 'string' &&
      node.text.trim() &&
      !shouldSkipValue(node.text)
    ) {
      const key = `t_${map.size}`
      map.set(key, node.text)
    }
    for (const k of Object.keys(node)) {
      extractLexicalTextNodes(node[k], map)
    }
  }
  return map
}

/**
 * Re-injects translated strings back into the Lexical AST
 */
export function applyLexicalTextNodes(
  node: any,
  translatedMap: Record<string, string>,
  counter = { idx: 0 },
): any {
  if (Array.isArray(node)) {
    return node.map((item) => applyLexicalTextNodes(item, translatedMap, counter))
  } else if (node && typeof node === 'object') {
    const copy: any = { ...node }
    if (
      copy.type === 'text' &&
      typeof copy.text === 'string' &&
      copy.text.trim() &&
      !shouldSkipValue(copy.text)
    ) {
      const key = `t_${counter.idx++}`
      if (translatedMap[key] !== undefined) {
        copy.text = translatedMap[key]
      }
    }
    for (const k of Object.keys(copy)) {
      copy[k] = applyLexicalTextNodes(copy[k], translatedMap, counter)
    }
    return copy
  }
  return node
}

/**
 * End-to-end AST translator: extracts text leaves, sends single batch request, and applies
 */
export async function translateLexicalAST(
  lexicalObj: any,
  targetLocale: string,
  sourceLocale = 'en',
  engineUrl = 'http://127.0.0.1:5000',
  apiKey?: string,
): Promise<any> {
  if (!lexicalObj || !isLexicalNode(lexicalObj)) return lexicalObj

  const textMap = extractLexicalTextNodes(lexicalObj)
  if (textMap.size === 0) return lexicalObj

  const plainObj: Record<string, string> = Object.fromEntries(textMap.entries())
  const translatedMap = await translateJsonObjectViaLibre(
    plainObj,
    targetLocale,
    sourceLocale,
    engineUrl,
    apiKey,
  )

  return applyLexicalTextNodes(lexicalObj, translatedMap)
}
