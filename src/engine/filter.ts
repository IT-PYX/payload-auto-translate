/**
 * HTML Entity Decoder
 */
export function decodeHtmlEntities(str: string): string {
  if (!str || typeof str !== 'string') return str
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

export const SYSTEM_VALUES_EXCLUSIONS = new Set([
  'en', 'es', 'fr', 'ar', 'pt', 'de', 'ru', 'ja', 'zh', 'it', 'nl', 'ko', 'tr', 'pl',
  'centered', 'left', 'right', 'top', 'bottom', 'grid', 'list', 'full', 'banner', 'columns',
  'default', 'primary', 'secondary', 'dark', 'light', 'none',
  'auto', 'contain', 'cover', 'solid', 'dashed', 'dotted', 'medium', 'large', 'small',
  'md', 'lg', 'sm', 'xs', 'xl', '2xl', '3xl',
  'true', 'false', 'null', 'undefined',
])

export const SYSTEM_FIELD_EXCLUSIONS = new Set([
  'id',
  '_locale',
  '_parent_id',
  '_order',
  '_path',
  'block_name',
  'created_at',
  'updated_at',
  'createdAt',
  'updatedAt',
  'blockType',
  'blockName',
  'layout',
  'status',
  'alignment',
  'color',
  'theme',
  'icon',
  'anchor_id',
  'type',
  'mode',
  'format',
  'direction',
  'style',
  'variant',
  'size',
  'display_type',
  'displayType',
  'action_type',
  'actionType',
  'target',
  'position',
  'shape',
  'fit',
  'aspect_ratio',
  'email',
  'href',
  'url',
  'link',
  'slug',
])

/**
 * Checks if a string value should be skipped during translation.
 */
export function shouldSkipValue(
  val: unknown,
  customValueExclusions?: Set<string>,
  customValuePatterns?: (string | RegExp)[],
): boolean {
  if (!val || typeof val !== 'string') return true
  const trimmed = val.trim()
  if (!trimmed) return true

  // URLs, protocols, and absolute web paths
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('tel:') ||
    trimmed.startsWith('data:')
  ) {
    return true
  }

  // System enum values
  if (SYSTEM_VALUES_EXCLUSIONS.has(trimmed.toLowerCase())) {
    return true
  }

  // Custom value exclusions
  if (customValueExclusions && (customValueExclusions.has(trimmed) || customValueExclusions.has(trimmed.toLowerCase()))) {
    return true
  }

  // Custom value patterns (regexes for specs/tokens)
  if (customValuePatterns && customValuePatterns.length > 0) {
    for (const pat of customValuePatterns) {
      if (pat instanceof RegExp) {
        if (pat.test(trimmed)) return true
      } else if (typeof pat === 'string' && pat) {
        try {
          if (new RegExp(pat, 'i').test(trimmed)) return true
        } catch {}
      }
    }
  }

  // UUIDs or ObjectIds
  if (/^[0-9a-fA-F]{24}$/.test(trimmed) || /^[0-9a-fA-F-]{36}$/.test(trimmed)) {
    return true
  }

  // Email addresses
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return true
  }

  // Pure numeric, measurements, percentages, phone numbers, or symbols
  if (/^[0-9\-+.,%/ ()#]+$/.test(trimmed)) {
    return true
  }

  // Media and file extensions
  if (/\.(png|jpe?g|webp|svg|gif|avif|ico|pdf|mp4|mov|webm|css|js|json|xml|zip|tar|gz)$/i.test(trimmed)) {
    return true
  }

  // Generic image/asset names
  if (/^(img|image|photo|picture|placeholder|icon|logo|file)(\s*\d+)?(\.[a-z0-9]+)?$/i.test(trimmed)) {
    return true
  }

  // Color hex codes (#fff, #ffffff)
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) {
    return true
  }

  return false
}

/**
 * Checks if a field name should be excluded from translation.
 */
export function isTranslatableField(
  fieldName: string,
  customExclusions?: Set<string>,
  allowSlug = false,
): boolean {
  if (fieldName === 'slug') return allowSlug
  if (SYSTEM_FIELD_EXCLUSIONS.has(fieldName)) return false
  if (customExclusions && customExclusions.has(fieldName)) return false
  if (fieldName.startsWith('_')) return false
  if (fieldName.endsWith('_id') || fieldName.endsWith('Id')) return false

  // Generic link and URL field pattern matching across any project
  if (
    fieldName.endsWith('_href') ||
    fieldName.endsWith('Href') ||
    fieldName.endsWith('_url') ||
    fieldName.endsWith('Url') ||
    fieldName.endsWith('_link') ||
    fieldName.endsWith('Link')
  ) {
    return false
  }

  return true
}
