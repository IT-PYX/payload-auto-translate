import type { Endpoint, PayloadRequest } from 'payload'
import type { TranslationQueue } from '../queue/translation-queue'
import type { DatabaseCrawler } from '../crawler/database-crawler'
import { checkLibreTranslateHealth } from '../engine/libretranslate'

export interface EndpointContext {
  queue: TranslationQueue
  crawler: DatabaseCrawler
  engineUrl: string
  apiKey?: string
  sourceLocale: string
  targetLocales: string[]
}

function requireAuth(handler: (req: PayloadRequest) => Promise<Response>) {
  return async (req: PayloadRequest) => {
    if (!req.user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return handler(req)
  }
}

export function createAutoTranslateEndpoints(context: EndpointContext): Endpoint[] {
  return [
    {
      path: '/auto-translate/status',
      method: 'get',
      handler: requireAuth(async () => {
        const health = await checkLibreTranslateHealth(context.engineUrl, context.apiKey)
        return Response.json({
          engine: {
            url: context.engineUrl,
            ...health,
          },
          locales: {
            source: context.sourceLocale,
            targets: context.targetLocales,
          },
          queue: context.queue.stats,
          bulk: context.crawler.currentProgress,
        })
      }),
    },
    {
      path: '/auto-translate/start-bulk',
      method: 'post',
      handler: requireAuth(async () => {
        if (context.crawler.currentProgress.status === 'running') {
          return Response.json(
            { message: 'A bulk translation job is already in progress' },
            { status: 409 },
          )
        }

        const health = await checkLibreTranslateHealth(context.engineUrl, context.apiKey)
        if (!health.ok) {
          return Response.json(
            {
              error: 'Translation engine is unreachable',
              engine: { url: context.engineUrl, ...health },
            },
            { status: 503 },
          )
        }

        // Trigger crawler asynchronously in background
        context.crawler.run().catch((err: any) => {
          console.error('[auto-translate] Bulk crawl error:', err.message)
        })

        return Response.json({
          message: 'Bulk translation initiated in background',
          status: 'running',
        })
      }),
    },
    {
      path: '/auto-translate/bulk-progress',
      method: 'get',
      handler: requireAuth(async () => {
        return Response.json(context.crawler.currentProgress)
      }),
    },
  ]
}
