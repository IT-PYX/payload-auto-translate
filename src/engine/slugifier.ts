const NON_LATIN_LOCALES = new Set([
  'ar',
  'ru',
  'ja',
  'zh',
  'ko',
  'he',
  'fa',
  'hi',
  'th',
  'el',
  'uk',
  'bg',
])

export interface SlugifyOptions {
  latinLocalesOnly?: boolean
  maxLength?: number
}

/**
 * Generates a clean, SEO-optimized URL slug from a title or text string.
 * Supports German umlaut expansion, Unicode diacritic stripping,
 * and safe fallback for non-Latin locales.
 */
export function defaultSlugify(
  text: string,
  locale = 'en',
  options: SlugifyOptions = {},
): string {
  if (!text || typeof text !== 'string') return ''
  const latinOnly = options.latinLocalesOnly ?? true
  const maxLen = options.maxLength ?? 90

  // If locale is non-Latin and latinLocalesOnly is enabled, return empty string
  // which signals callers to safely preserve the source ASCII slug.
  if (latinOnly && NON_LATIN_LOCALES.has(locale)) {
    return ''
  }

  let slug = text.trim()

  // German umlaut expansions
  if (locale === 'de' || !latinOnly) {
    slug = slug
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/Ä/g, 'Ae')
      .replace(/Ö/g, 'Oe')
      .replace(/Ü/g, 'Ue')
      .replace(/ß/g, 'ss')
  }

  // Decompose Unicode accents (é -> e, ñ -> n, ç -> c)
  slug = slug
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

  if (latinOnly) {
    slug = slug.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  } else {
    // Unicode-aware regex preserving native letters & numbers
    slug = slug.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  }

  if (slug.length > maxLen) {
    const cut = slug.slice(0, maxLen)
    const lastHyphen = cut.lastIndexOf('-')
    slug = (lastHyphen > 30 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/, '')
  }

  return slug
}
