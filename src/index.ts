import type { Config, Plugin } from 'payload'
import type { AutoTranslatePluginOptions } from './types'
import { TranslationQueue } from './queue/translation-queue'
import { DatabaseCrawler } from './crawler/database-crawler'
import { createCollectionAfterChangeHook, createGlobalAfterChangeHook } from './hooks/afterChange'
import { createAutoTranslateEndpoints } from './api/endpoints'

export * from './types'
export { DatabaseCrawler } from './crawler/database-crawler'
export { TranslationQueue, localizeItemIds } from './queue/translation-queue'
export { translateDocument, mergePreservingExisting, extractTranslatableStrings, applyTranslationsToDocument } from './engine/document-translator'
export { translateLexicalAST } from './engine/lexical-compressor'
export { checkLibreTranslateHealth, translateBatchViaLibre } from './engine/libretranslate'
export { defaultSlugify } from './engine/slugifier'
export { isTranslatableField, shouldSkipValue } from './engine/filter'

export const autoTranslatePlugin =
  (pluginOptions: AutoTranslatePluginOptions = {}): Plugin =>
  (incomingConfig: Config): Config => {
    if (pluginOptions.disabled) {
      return incomingConfig
    }

    // 1. Resolve source and target locales
    let sourceLocale = pluginOptions.sourceLocale
    let targetLocales = pluginOptions.targetLocales

    if (!sourceLocale) {
      if (typeof incomingConfig.localization === 'object' && incomingConfig.localization) {
        sourceLocale = incomingConfig.localization.defaultLocale || 'en'
      } else {
        sourceLocale = 'en'
      }
    }

    if (!targetLocales || targetLocales.length === 0) {
      if (typeof incomingConfig.localization === 'object' && incomingConfig.localization) {
        const allLocales = incomingConfig.localization.locales.map((loc) =>
          typeof loc === 'string' ? loc : loc.code,
        )
        targetLocales = allLocales.filter((code) => code !== sourceLocale)
      } else {
        targetLocales = ['es', 'fr', 'ar', 'pt', 'de', 'ru', 'ja']
      }
    }

    const engineUrl =
      pluginOptions.engine?.url || process.env.LIBRETRANSLATE_URL || 'http://127.0.0.1:5000'
    const apiKey = pluginOptions.engine?.apiKey || process.env.LIBRETRANSLATE_API_KEY

    // Excluded fields mapping per collection
    const excludedFieldsMap: Record<string, string[]> = {}
    if (pluginOptions.collections) {
      for (const [slug, conf] of Object.entries(pluginOptions.collections)) {
        if (typeof conf === 'object' && conf !== null && 'excludedFields' in conf && conf.excludedFields) {
          excludedFieldsMap[slug] = conf.excludedFields
        }
      }
    }

    // 2. Initialize queue & bulk crawler
    const queue = new TranslationQueue({
      engineUrl,
      apiKey,
      concurrency: pluginOptions.activeTranslation?.concurrency || 2,
      excludedFieldsMap,
      customFieldExclusions: pluginOptions.customFieldExclusions,
      customValueExclusions: pluginOptions.customValueExclusions,
      slug: pluginOptions.slug,
      collections: pluginOptions.collections,
    })

    // Derive bulk crawler table filter from enabled collections/globals
    let bulkOnlyTables = pluginOptions.bulk?.onlyTables
    if (!bulkOnlyTables) {
      const slugs: string[] = []
      if (pluginOptions.collections) {
        for (const [slug, conf] of Object.entries(pluginOptions.collections)) {
          if (conf !== false) slugs.push(slug)
        }
      }
      if (pluginOptions.globals) {
        for (const [slug, conf] of Object.entries(pluginOptions.globals)) {
          if (conf !== false) slugs.push(slug)
        }
      }
      if (slugs.length > 0) bulkOnlyTables = slugs
    }

    const crawler = new DatabaseCrawler({
      engineUrl,
      apiKey,
      sourceLocale,
      targetLocales,
      onlyTables: bulkOnlyTables,
      includeVersions: pluginOptions.bulk?.includeVersions ?? false,
    })

    const hookContext = {
      queue,
      options: pluginOptions,
      sourceLocale,
      targetLocales,
    }

    // 3. Patch collections with afterChange hooks
    const activeEnabled = pluginOptions.activeTranslation?.enabled !== false
    const collectionsToTranslate = pluginOptions.collections

    const patchedCollections = (incomingConfig.collections || []).map((collection) => {
      // Check if this collection is explicitly included or omitted
      if (collectionsToTranslate) {
        const isIncluded = collectionsToTranslate[collection.slug]
        if (isIncluded === false) return collection
      }

      // Avoid media, users, submissions, etc. by default unless specified
      const defaultIgnored = new Set([
        'media',
        'users',
        'payload-preferences',
        'payload-migrations',
        'submissions',
      ])
      if (!collectionsToTranslate && defaultIgnored.has(collection.slug)) {
        return collection
      }

      if (!activeEnabled) return collection

      return {
        ...collection,
        hooks: {
          ...collection.hooks,
          afterChange: [
            ...(collection.hooks?.afterChange || []),
            createCollectionAfterChangeHook(collection.slug, hookContext),
          ],
        },
      }
    })

    // 4. Patch globals with afterChange hooks
    const globalsToTranslate = pluginOptions.globals
    const patchedGlobals = (incomingConfig.globals || []).map((global) => {
      if (globalsToTranslate) {
        const isIncluded = globalsToTranslate[global.slug]
        if (isIncluded === false) return global
      }

      if (!activeEnabled) return global

      return {
        ...global,
        hooks: {
          ...global.hooks,
          afterChange: [
            ...(global.hooks?.afterChange || []),
            createGlobalAfterChangeHook(global.slug, hookContext),
          ],
        },
      }
    })

    // 5. Register custom endpoints
    const endpoints = createAutoTranslateEndpoints({
      queue,
      crawler,
      engineUrl,
      apiKey,
      sourceLocale,
      targetLocales,
    })

    return {
      ...incomingConfig,
      collections: patchedCollections,
      globals: patchedGlobals,
      endpoints: [...(incomingConfig.endpoints || []), ...endpoints],
    }
  }

export default autoTranslatePlugin
