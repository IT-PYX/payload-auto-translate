import type { CollectionAfterChangeHook, GlobalAfterChangeHook, PayloadRequest } from 'payload'
import type { TranslationQueue } from '../queue/translation-queue'
import type { AutoTranslatePluginOptions } from '../types'

export interface HookContext {
  queue: TranslationQueue
  options: AutoTranslatePluginOptions
  sourceLocale: string
  targetLocales: string[]
}

/**
 * Creates an afterChange hook for Collections that dispatches background translations.
 */
export function createCollectionAfterChangeHook(
  slug: string,
  context: HookContext,
): CollectionAfterChangeHook {
  const { queue, options, sourceLocale, targetLocales } = context
  const activeOpts = options.activeTranslation || {}

  return async ({ doc, operation, req }: { doc: any; operation: string; req: PayloadRequest }) => {
    // 1. Safety Guard: Skip if triggered by auto-translator to avoid infinite loops
    if (req?.context?.isAutoTranslating) {
      return doc
    }

    // 2. Only translate when changes are made to the source locale (e.g. 'en')
    if (req?.locale && req.locale !== sourceLocale) {
      return doc
    }

    // 3. Check trigger operations ('create', 'update')
    const allowedOps = activeOpts.triggerOn || ['create', 'update']
    if (!allowedOps.includes(operation as any)) {
      return doc
    }

    // 4. Optionally skip drafts
    if (activeOpts.translateDrafts === false && doc?._status === 'draft') {
      return doc
    }

    // Ensure queue has payload instance
    if (req?.payload) {
      queue.setPayload(req.payload)
    }

    // 5. Dispatch to background worker without blocking HTTP response
    queue.add({
      id: `${slug}-${doc.id}-${Date.now()}`,
      entityType: 'collection',
      slug,
      docId: doc.id,
      sourceLocale,
      targetLocales,
      data: doc,
      timestamp: Date.now(),
    })

    return doc
  }
}

/**
 * Creates an afterChange hook for Globals that dispatches background translations.
 */
export function createGlobalAfterChangeHook(
  slug: string,
  context: HookContext,
): GlobalAfterChangeHook {
  const { queue, options, sourceLocale, targetLocales } = context
  const activeOpts = options.activeTranslation || {}

    return async ({ doc, req }: { doc: any; req: PayloadRequest }) => {
    if (req?.context?.isAutoTranslating) {
      return doc
    }

    if (req?.locale && req.locale !== sourceLocale) {
      return doc
    }

    // Optionally skip drafts
    if (activeOpts.translateDrafts === false && doc?._status === 'draft') {
      return doc
    }

    if (req?.payload) {
      queue.setPayload(req.payload)
    }

    queue.add({
      id: `${slug}-global-${Date.now()}`,
      entityType: 'global',
      slug,
      sourceLocale,
      targetLocales,
      data: doc,
      timestamp: Date.now(),
    })

    return doc
  }
}
