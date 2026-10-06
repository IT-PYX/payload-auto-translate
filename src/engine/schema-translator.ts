import type { SchemaTranslationOptions, FallbackRetryOptions } from '../types'
import { shouldSkipValue } from './filter'
import { translateBatchViaLibre } from './libretranslate'

/**
 * Standard Schema.org types whose name property represents an organization or brand
 * and should NOT be machine-translated.
 */
const ENTITY_NAME_SKIP_TYPES = new Set([
  'Organization',
  'Corporation',
  'Brand',
  'LocalBusiness',
  'Person',
  'EducationalOccupationalCredential',
])

/**
 * Standard Schema.org properties whitelisted for natural-language translation.
 */
const TRANSLATABLE_SCHEMA_PROPERTIES = new Set([
  'description',
  'headline',
  'alternativeHeadline',
  'caption',
  'text',
  'keywords',
  'articleBody',
  'disambiguatingDescription',
  'reviewBody',
  'serviceType',
])

/**
 * Global entity URI fragments that MUST remain global across all languages
 * to preserve Google Knowledge Graph entity consolidation.
 */
const GLOBAL_ENTITY_FRAGMENTS = new Set(['#organization', '#website', '#logo'])

/**
 * Static asset extensions that should not be prefixed with language locales.
 */
const STATIC_ASSET_EXTENSIONS = /\.(png|jpe?g|webp|svg|gif|avif|ico|pdf|mp4|mov|webm)$/i

/**
 * Localizes an absolute URL for a target locale, preserving global singletons and assets.
 */
export function localizeSchemaUrl(
  urlStr: string,
  targetLocale: string,
  siteUrl?: string,
  customLocalizer?: (pathname: string, targetLocale: string) => string,
): string {
  if (!urlStr || typeof urlStr !== 'string') return urlStr
  if (!siteUrl || !urlStr.startsWith(siteUrl)) return urlStr

  try {
    const parsed = new URL(urlStr)

    // Preserve global singletons (#organization, #website, #logo)
    if (parsed.hash && GLOBAL_ENTITY_FRAGMENTS.has(parsed.hash.toLowerCase())) {
      return urlStr
    }

    // Do not localize static asset URLs (/images/..., .jpg, .svg)
    if (STATIC_ASSET_EXTENSIONS.test(parsed.pathname) || parsed.pathname.startsWith('/images/')) {
      return urlStr
    }

    // Use custom localizer if provided
    if (customLocalizer) {
      const localizedPath = customLocalizer(parsed.pathname, targetLocale)
      return `${siteUrl}${localizedPath}${parsed.hash}`
    }

    // Default localizer: strip existing 2-letter language prefix if present, then prepend targetLocale
    let cleanPath = parsed.pathname
    const langPrefixMatch = cleanPath.match(/^\/([a-z]{2})(\/|$)/i)
    if (langPrefixMatch) {
      cleanPath = cleanPath.substring(langPrefixMatch[1].length + 1) || '/'
    }

    // Root path: e.g. /es (no trailing slash for canonical consistency)
    if (cleanPath === '/' || cleanPath === '') {
      return `${siteUrl}/${targetLocale}${parsed.hash}`
    }

    const localizedPath = `/${targetLocale}${cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`}`
    return `${siteUrl}${localizedPath}${parsed.hash}`
  } catch {
    return urlStr
  }
}

/**
 * Extracts translatable natural-language strings from a Schema.org structure.
 */
export function extractTranslatableSchemaStrings(
  node: any,
  strings: Set<string> = new Set(),
  customValueExclusions?: Set<string>,
  customValuePatterns?: (string | RegExp)[],
): Set<string> {
  if (!node || typeof node !== 'object') return strings

  if (Array.isArray(node)) {
    for (const item of node) {
      extractTranslatableSchemaStrings(item, strings, customValueExclusions, customValuePatterns)
    }
    return strings
  }

  // Handle @graph root
  if (Array.isArray(node['@graph'])) {
    for (const item of node['@graph']) {
      extractTranslatableSchemaStrings(item, strings, customValueExclusions, customValuePatterns)
    }
    return strings
  }

  const nodeType = node['@type']
  const isSkipTypeName =
    nodeType &&
    (Array.isArray(nodeType)
      ? nodeType.some((t) => ENTITY_NAME_SKIP_TYPES.has(String(t)))
      : ENTITY_NAME_SKIP_TYPES.has(String(nodeType)))

  for (const [key, value] of Object.entries(node)) {
    // 1. Whitelisted direct text properties
    if (TRANSLATABLE_SCHEMA_PROPERTIES.has(key)) {
      if (typeof value === 'string') {
        if (!shouldSkipValue(value, customValueExclusions, customValuePatterns)) {
          strings.add(value)
        }
      } else if (Array.isArray(value)) {
        for (const v of value) {
          if (typeof v === 'string' && !shouldSkipValue(v, customValueExclusions, customValuePatterns)) {
            strings.add(v)
          }
        }
      }
    } else if (key === 'name') {
      // Name property: translate on Products, WebPages, FAQs, Articles, Questions
      // but NOT on Organization, Brand, Credential, etc.
      if (!isSkipTypeName && typeof value === 'string') {
        if (!shouldSkipValue(value, customValueExclusions, customValuePatterns)) {
          strings.add(value)
        }
      }
    } else if (key === 'knowsAbout' || key === 'about') {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string') {
            if (!shouldSkipValue(item, customValueExclusions, customValuePatterns)) {
              strings.add(item)
            }
          } else if (typeof item === 'object' && item !== null) {
            extractTranslatableSchemaStrings(item, strings, customValueExclusions, customValuePatterns)
          }
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      // Recurse into nested objects/arrays (e.g. mainEntity, acceptedAnswer, hasOfferCatalog, itemListElement)
      extractTranslatableSchemaStrings(value, strings, customValueExclusions, customValuePatterns)
    }
  }

  return strings
}

/**
 * Injects translated strings back into a Schema.org structure and localizes internal URLs.
 */
export function applySchemaTranslations(
  node: any,
  translationMap: Map<string, string>,
  targetLocale: string,
  options: SchemaTranslationOptions = {},
  customValueExclusions?: Set<string>,
  customValuePatterns?: (string | RegExp)[],
): any {
  if (!node || typeof node !== 'object') return node

  if (Array.isArray(node)) {
    return node.map((item) =>
      applySchemaTranslations(
        item,
        translationMap,
        targetLocale,
        options,
        customValueExclusions,
        customValuePatterns,
      ),
    )
  }

  const result: Record<string, any> = {}

  // Handle @graph root
  if (Array.isArray(node['@graph'])) {
    result['@context'] = node['@context'] || 'https://schema.org'
    result['@graph'] = node['@graph'].map((item: any) =>
      applySchemaTranslations(
        item,
        translationMap,
        targetLocale,
        options,
        customValueExclusions,
        customValuePatterns,
      ),
    )
    return result
  }

  const nodeType = node['@type']
  const isSkipTypeName =
    nodeType &&
    (Array.isArray(nodeType)
      ? nodeType.some((t) => ENTITY_NAME_SKIP_TYPES.has(String(t)))
      : ENTITY_NAME_SKIP_TYPES.has(String(nodeType)))

  for (const [key, value] of Object.entries(node)) {
    // 1. inLanguage injection/update
    if (key === 'inLanguage') {
      result[key] = targetLocale
      continue
    }

    // 2. Localize URLs and @id references
    if (key === 'url' || key === 'item') {
      if (typeof value === 'string') {
        result[key] = localizeSchemaUrl(value, targetLocale, options.siteUrl, options.localizePath)
        continue
      }
    }

    if (key === '@id' && typeof value === 'string') {
      result[key] = localizeSchemaUrl(value, targetLocale, options.siteUrl, options.localizePath)
      continue
    }

    // 3. Whitelisted text properties
    if (TRANSLATABLE_SCHEMA_PROPERTIES.has(key)) {
      if (typeof value === 'string') {
        result[key] = translationMap.get(value) || value
      } else if (Array.isArray(value)) {
        result[key] = value.map((v) => (typeof v === 'string' ? translationMap.get(v) || v : v))
      } else {
        result[key] = value
      }
    } else if (key === 'name') {
      if (!isSkipTypeName && typeof value === 'string') {
        result[key] = translationMap.get(value) || value
      } else {
        result[key] = value
      }
    } else if (key === 'knowsAbout' || key === 'about') {
      if (Array.isArray(value)) {
        result[key] = value.map((item) => {
          if (typeof item === 'string') {
            return translationMap.get(item) || item
          }
          if (typeof item === 'object' && item !== null) {
            return applySchemaTranslations(
              item,
              translationMap,
              targetLocale,
              options,
              customValueExclusions,
              customValuePatterns,
            )
          }
          return item
        })
      } else {
        result[key] = value
      }
    } else if (typeof value === 'object' && value !== null) {
      result[key] = applySchemaTranslations(
        value,
        translationMap,
        targetLocale,
        options,
        customValueExclusions,
        customValuePatterns,
      )
    } else {
      result[key] = value
    }
  }

  // Set inLanguage on creative work, webpage, or article nodes if not already present
  const isCreativeWorkOrPage =
    nodeType &&
    (Array.isArray(nodeType)
      ? nodeType.some((t) => ['WebPage', 'WebSite', 'Article', 'FAQPage', 'AboutPage', 'ContactPage'].includes(String(t)))
      : ['WebPage', 'WebSite', 'Article', 'FAQPage', 'AboutPage', 'ContactPage'].includes(String(nodeType)))

  if (isCreativeWorkOrPage && !result.inLanguage) {
    result.inLanguage = targetLocale
  }

  return result
}

/**
 * End-to-end Schema.org JSON-LD translator and localizer.
 */
export async function translateSchemaJSONLD(
  schema: any,
  targetLocale: string,
  sourceLocale: string = 'en',
  engineUrl?: string,
  apiKey?: string,
  options: SchemaTranslationOptions = {},
  customValueExclusions?: string[],
  customValuePatterns?: (string | RegExp)[],
  fallbackRetry?: FallbackRetryOptions,
): Promise<any> {
  if (!schema || typeof schema !== 'object') return schema

  const valExclSet = customValueExclusions ? new Set(customValueExclusions) : undefined
  const distinctStrings = extractTranslatableSchemaStrings(
    schema,
    new Set(),
    valExclSet,
    customValuePatterns,
  )

  const stringArray = Array.from(distinctStrings)
  let translationMap = new Map<string, string>()

  if (stringArray.length > 0) {
    translationMap = await translateBatchViaLibre(
      stringArray,
      targetLocale,
      sourceLocale,
      engineUrl,
      apiKey,
      15, // chunkSize
      3,  // maxRetries
      undefined,
      fallbackRetry,
    )
  }

  return applySchemaTranslations(
    schema,
    translationMap,
    targetLocale,
    options,
    valExclSet,
    customValuePatterns,
  )
}
