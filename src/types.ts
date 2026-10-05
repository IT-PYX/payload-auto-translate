export interface EngineOptions {
  type?: 'libretranslate'
  url?: string
  apiKey?: string
}

export interface ActiveTranslationOptions {
  enabled?: boolean
  onlySourceLocale?: boolean
  triggerOn?: ('create' | 'update')[]
  translateDrafts?: boolean
  concurrency?: number
}

export interface CollectionConfigOptions {
  excludedFields?: string[]
  translateSlug?: boolean
}

export interface SlugTranslationOptions {
  /**
   * Whether to automatically generate translated slugs.
   * Default: false (preserves source slug across locales).
   */
  enabled?: boolean

  /**
   * If true, only generate translated slugs for Latin-script locales (es, fr, de, it, pt, etc.)
   * and preserve the stable ASCII slug for non-Latin locales (ar, ja, ru, zh, etc.).
   * Default: true.
   */
  latinLocalesOnly?: boolean

  /**
   * The source field to derive the slug from if translated (default: 'title' or 'name').
   */
  sourceField?: string

  /**
   * Optional custom slug generator function.
   * Receives (translatedTitle, targetLocale, sourceSlug) and returns the localized slug.
   */
  slugify?: (title: string, locale: string, currentSlug?: string) => string
}

export interface AutoTranslatePluginOptions {
  /**
   * Translation engine configuration.
   * Defaults to LibreTranslate at http://127.0.0.1:5000 or process.env.LIBRETRANSLATE_URL
   */
  engine?: EngineOptions

  /**
   * Source language code (default 'en')
   */
  sourceLocale?: string

  /**
   * Target language codes to translate into (default: all other configured locales)
   */
  targetLocales?: string[]

  /**
   * Real-time background translation when an editor saves in CMS
   */
  activeTranslation?: ActiveTranslationOptions

  /**
   * Optional slug translation configuration.
   * Default: disabled (slugs remain untouched).
   */
  slug?: SlugTranslationOptions

  /**
   * Custom field names to exclude globally across all collections.
   */
  customFieldExclusions?: string[]

  /**
   * Custom exact string values, internal tokens, or keywords to skip during translation.
   */
  customValueExclusions?: string[]

  /**
   * Custom RegExp patterns (or regex strings) to skip during translation.
   * Useful for domain-specific tokens or hardware specs (e.g. [/^IP\d+/, /^RS-?485/i, /^\d+\s*VAC/i]).
   */
  customValuePatterns?: (string | RegExp)[]

  /**
   * Optional fallback retry configuration for strings that LibreTranslate echoes untranslated (such as Title Cased headlines).
   * Default: disabled.
   */
  fallbackRetry?: FallbackRetryOptions

  /**
   * Collections to include or customize
   */
  collections?: Record<string, boolean | CollectionConfigOptions>

  /**
   * Globals to include or customize
   */
  globals?: Record<string, boolean | CollectionConfigOptions>

  /**
   * Bulk crawler configuration.
   * onlyTables defaults to the enabled collections/globals slugs.
   * includeVersions defaults to false (version tables are historical noise).
   */
  bulk?: {
    onlyTables?: string[]
    includeVersions?: boolean
  }

  /**
   * Temporarily disable plugin without removing it
   */
  disabled?: boolean
}

export interface FallbackRetryOptions {
  /**
   * Whether to enable fallback retry when strings return untranslated (such as Title Cased headlines).
   * Default: false (disabled).
   */
  enabled?: boolean

  /**
   * Strategy for fallback transformation.
   * 'sentence-case' transforms "Headline Words In Title Case" -> "Headline words in title case" before retrying.
   * 'lower-case' transforms to lowercase.
   * Default: 'sentence-case'
   */
  strategy?: 'sentence-case' | 'lower-case'
}

export interface TranslationJob {
  id: string
  entityType: 'collection' | 'global'
  slug: string
  docId?: string | number
  sourceLocale: string
  targetLocales: string[]
  data: Record<string, any>
  timestamp: number
  retries?: number
}

export interface BulkProgress {
  status: 'idle' | 'running' | 'completed' | 'failed'
  startTime?: number
  endTime?: number
  totalTables?: number
  processedTables?: number
  currentTable?: string
  totalStrings?: number
  translatedStrings?: number
  failedStrings?: number
  insertedRows?: number
  updatedRows?: number
  skippedRows?: number
  error?: string
}

export interface CrawlerOptions {
  connectionString?: string
  sourceLocale?: string
  targetLocales?: string[]
  engineUrl?: string
  apiKey?: string
  onlyTables?: string[]
  includeVersions?: boolean
  isLive?: boolean
  customValueExclusions?: string[]
  customValuePatterns?: (string | RegExp)[]
  fallbackRetry?: FallbackRetryOptions
  onProgress?: (progress: BulkProgress) => void
}
