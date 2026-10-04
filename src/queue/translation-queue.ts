import type { Payload } from 'payload'
import type { CollectionConfigOptions, SlugTranslationOptions, TranslationJob } from '../types'
import { translateDocument, mergePreservingExisting } from '../engine/document-translator'
import { defaultSlugify } from '../engine/slugifier'

export interface QueueStats {
  queued: number
  active: number
  completed: number
  failed: number
  lastProcessedAt?: number
  lastError?: string
}

export interface TranslationQueueOptions {
  engineUrl?: string
  apiKey?: string
  concurrency?: number
  excludedFieldsMap?: Record<string, string[]>
  customFieldExclusions?: string[]
  customValueExclusions?: string[]
  slug?: SlugTranslationOptions
  collections?: Record<string, boolean | CollectionConfigOptions>
}

export class TranslationQueue {
  private queue: TranslationJob[] = []
  private activeJobs = new Map<string, TranslationJob>()
  private debounceTimers = new Map<string, NodeJS.Timeout>()
  private isProcessing = false
  private payload: Payload | null = null
  private engineUrl: string
  private apiKey?: string
  private excludedFieldsMap: Map<string, string[]> = new Map()
  private customFieldExclusions?: string[]
  private customValueExclusions?: string[]
  private slugOptions?: SlugTranslationOptions
  private collectionsConfig?: Record<string, boolean | CollectionConfigOptions>
  private concurrency: number

  public stats: QueueStats = {
    queued: 0,
    active: 0,
    completed: 0,
    failed: 0,
  }

  constructor(options: TranslationQueueOptions = {}) {
    this.engineUrl = options.engineUrl || 'http://127.0.0.1:5000'
    this.apiKey = options.apiKey
    this.concurrency = options.concurrency || 2
    this.customFieldExclusions = options.customFieldExclusions
    this.customValueExclusions = options.customValueExclusions
    this.slugOptions = options.slug
    this.collectionsConfig = options.collections
    if (options.excludedFieldsMap) {
      for (const [key, fields] of Object.entries(options.excludedFieldsMap)) {
        this.excludedFieldsMap.set(key, fields)
      }
    }
  }

  public setPayload(payload: Payload): void {
    this.payload = payload
  }

  /**
   * Pushes a job to the background queue with a 1-second debounce per document
   */
  public add(job: TranslationJob): void {
    const jobKey = `${job.entityType}:${job.slug}:${job.docId || 'global'}`

    // Clear existing debounce timer if user saved again rapidly
    if (this.debounceTimers.has(jobKey)) {
      clearTimeout(this.debounceTimers.get(jobKey)!)
      this.debounceTimers.delete(jobKey)
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(jobKey)

      // Replace any older pending job in the queue for this same document
      this.queue = this.queue.filter((j) => {
        const k = `${j.entityType}:${j.slug}:${j.docId || 'global'}`
        return k !== jobKey
      })

      this.queue.push(job)
      this.stats.queued = this.queue.length
      this.processNext()
    }, 1000)

    this.debounceTimers.set(jobKey, timer)
  }

  private async processNext(): Promise<void> {
    if (this.activeJobs.size >= this.concurrency || this.queue.length === 0) {
      return
    }

    const job = this.queue.shift()
    if (!job) return

    const jobKey = `${job.entityType}:${job.slug}:${job.docId || 'global'}`
    this.activeJobs.set(jobKey, job)
    this.stats.queued = this.queue.length
    this.stats.active = this.activeJobs.size

    // Execute in background
    ;(async () => {
      try {
        await this.executeJob(job)
        this.stats.completed++
        this.stats.lastProcessedAt = Date.now()
      } catch (err: any) {
        console.error(`[auto-translate] Job failed for ${jobKey}:`, err.message)
        this.stats.failed++
        this.stats.lastError = err.message
      } finally {
        this.activeJobs.delete(jobKey)
        this.stats.active = this.activeJobs.size
        // Trigger next job in queue
        this.processNext()
      }
    })()
  }

  private async executeJob(job: TranslationJob): Promise<void> {
    if (!this.payload) {
      console.warn('[auto-translate] Payload instance not set on queue. Skipping job.')
      return
    }

    const perCollectionExcluded = this.excludedFieldsMap.get(job.slug) || []
    const excludedFields = [
      ...perCollectionExcluded,
      ...(this.customFieldExclusions || []),
    ]

    // Determine whether slug translation is enabled for this collection
    const colOpts = job.entityType === 'collection' ? this.collectionsConfig?.[job.slug] : undefined
    const translateSlugConfig =
      typeof colOpts === 'object' && colOpts !== null && 'translateSlug' in colOpts
        ? Boolean(colOpts.translateSlug)
        : Boolean(this.slugOptions?.enabled)

    console.log(
      `[auto-translate] 🚀 Translating ${job.entityType} '${job.slug}' (ID: ${job.docId || 'global'}) into [${job.targetLocales.join(', ')}]...`,
    )

    for (const targetLocale of job.targetLocales) {
      try {
        // 1. Fetch existing document in target locale to detect already-translated fields
        let existingDoc: Record<string, any> = {}
        try {
          if (job.entityType === 'collection') {
            existingDoc = await this.payload.findByID({
              collection: job.slug as any,
              id: job.docId!,
              locale: targetLocale as any,
              depth: 0,
            })
          } else {
            const globals = await this.payload.findGlobal({
              slug: job.slug as any,
              locale: targetLocale as any,
              depth: 0,
            })
            existingDoc = globals || {}
          }
        } catch {
          // Document may not exist yet in this locale — that's fine, translate everything
          existingDoc = {}
        }

        // 2. Translate from source locale
        const translatedData = await translateDocument(
          job.data,
          targetLocale,
          job.sourceLocale,
          this.engineUrl,
          this.apiKey,
          excludedFields,
          translateSlugConfig,
          this.customValueExclusions,
        )

        // 3. Merge: only apply translations where target locale is empty
        const mergedData = mergePreservingExisting(translatedData, existingDoc)

        // 4. Handle optional slug translation if enabled and field is localized
        if (translateSlugConfig && job.entityType === 'collection') {
          const collectionConfig = this.payload.collections[job.slug]?.config
          const slugField = collectionConfig?.fields?.find(
            (f: any) =>
              f.name === (this.slugOptions?.sourceField || 'slug') || f.name === 'slug',
          )

          // Only translate slug if the field is localized on this collection
          if (slugField && 'localized' in slugField && slugField.localized) {
            const sourceSlug = job.data?.slug
            const existingSlug = existingDoc?.slug

            // Only compute translated slug if target slug is empty or equals the default source slug
            if (!existingSlug || existingSlug === sourceSlug) {
              const sourceTitle =
                translatedData.title ||
                translatedData.name ||
                job.data?.title ||
                job.data?.name ||
                ''

              let targetSlug = ''
              if (this.slugOptions?.slugify) {
                targetSlug = this.slugOptions.slugify(sourceTitle, targetLocale, sourceSlug)
              } else {
                targetSlug = defaultSlugify(sourceTitle, targetLocale, {
                  latinLocalesOnly: this.slugOptions?.latinLocalesOnly ?? true,
                })
              }

              // Safe fallback: never let slug be empty
              mergedData.slug = targetSlug || sourceSlug
            }
          }
        }

        // Strip unlocalized or system properties before updating target locale
        delete mergedData.id
        delete mergedData.createdAt
        delete mergedData.updatedAt
        delete mergedData._status

        // Ensure all translated blocks and array items have localized IDs
        localizeItemIds(mergedData, targetLocale)

        // Preserve draft status if collection has versions/drafts
        const isDraft = job.data?._status === 'draft'

        if (job.entityType === 'collection') {
          await this.payload.update({
            collection: job.slug as any,
            id: job.docId!,
            locale: targetLocale as any,
            data: mergedData,
            draft: isDraft,
            context: {
              isAutoTranslating: true, // Infinite loop guard
            },
          })
        } else {
          await this.payload.updateGlobal({
            slug: job.slug as any,
            locale: targetLocale as any,
            data: mergedData,
            draft: isDraft,
            context: {
              isAutoTranslating: true, // Infinite loop guard
            },
          })
        }

        console.log(
          `  ✓ [${targetLocale.toUpperCase()}] Updated ${job.slug} (ID: ${job.docId || 'global'})`,
        )
      } catch (err: any) {
        console.error(
          `  ✗ [${targetLocale.toUpperCase()}] Failed for ${job.slug} (ID: ${job.docId || 'global'}): ${err.message}`,
        )
      }
    }
  }
}

export function localizeItemIds(item: any, targetLocale: string): void {
  if (!item || typeof item !== 'object') return

  if (typeof item.id === 'string' && item.id.length > 0) {
    // Strip any existing locale suffix before applying targetLocale to prevent chaining (_es_es or _fr_es)
    const baseId = item.id.replace(/_[a-z]{2}(-[A-Z]{2})?$/, '')
    item.id = `${baseId}_${targetLocale}`
  } else if (typeof item.id === 'number') {
    // For integer/serial primary keys, delete to allow database sequence autogeneration
    delete item.id
  }

  for (const key of Object.keys(item)) {
    if (key === 'blockType' || key === 'blockName') continue
    const val = item[key]
    if (Array.isArray(val)) {
      for (const child of val) {
        localizeItemIds(child, targetLocale)
      }
    } else if (typeof val === 'object' && val !== null) {
      localizeItemIds(val, targetLocale)
    }
  }
}
