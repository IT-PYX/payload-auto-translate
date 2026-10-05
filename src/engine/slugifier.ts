export const NON_LATIN_LOCALES = new Set([
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
 * Supports German umlaut expansion, Latin diacritic stripping,
 * and high-fidelity Unicode preservation for non-Latin scripts (Arabic, Japanese, Russian, etc.).
 */
export function defaultSlugify(
  text: string,
  locale = 'en',
  options: SlugifyOptions = {},
): string {
  if (!text || typeof text !== 'string') return ''
  const latinOnly = options.latinLocalesOnly ?? true
  const maxLen = options.maxLength ?? 120
  const isNonLatin = NON_LATIN_LOCALES.has(locale)

  // If locale is non-Latin and latinLocalesOnly is enabled, return empty string
  // which signals callers to safely preserve the source ASCII slug.
  if (latinOnly && isNonLatin) {
    return ''
  }

  let slug = text.trim()

  if (isNonLatin) {
    // For Arabic, strip tashkeel/vocalization marks if any: [\u064B-\u0652\u0670]
    if (locale === 'ar') {
      slug = slug.replace(/[\u064B-\u0652\u0670]/g, '')
    }
    // Normalize to NFC to preserve composed Unicode letters (e.g., й, ؤ, etc.)
    slug = slug.normalize('NFC').toLowerCase()
    // Replace punctuation, symbols, and spaces with hyphens while preserving native letters and numbers
    slug = slug.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  } else {
    // German umlaut expansions
    if (locale === 'de') {
      slug = slug
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/Ä/g, 'ae')
        .replace(/Ö/g, 'oe')
        .replace(/Ü/g, 'ue')
        .replace(/ß/g, 'ss')
    }

    // Decompose Unicode accents (é -> e, ñ -> n, ç -> c) for clean ASCII URLs
    slug = slug
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  }

  // Safe Unicode length truncation without breaking multi-byte or surrogate pairs
  const chars = Array.from(slug)
  if (chars.length > maxLen) {
    const cut = chars.slice(0, maxLen).join('')
    const lastHyphen = cut.lastIndexOf('-')
    // If a hyphen is present beyond 30% of maxLen, break cleanly at the word boundary;
    // otherwise (e.g. Japanese without hyphens), cleanly slice at maxLen.
    slug = (lastHyphen > Math.floor(maxLen * 0.3) ? cut.slice(0, lastHyphen) : cut).replace(/-+$/, '')
  }

  return slug
}
