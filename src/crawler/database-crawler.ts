import pg from 'pg'
import type { BulkProgress, CrawlerOptions } from '../types'
import { isTranslatableField, shouldSkipValue } from '../engine/filter'
import { translateBatchViaLibre } from '../engine/libretranslate'
import { isLexicalNode, extractLexicalTextNodes } from '../engine/lexical-compressor'

const { Pool } = pg

export class DatabaseCrawler {
  private options: CrawlerOptions
  private pool: pg.Pool | null = null
  public currentProgress: BulkProgress = {
    status: 'idle',
  }

  constructor(options: CrawlerOptions = {}) {
    this.options = {
      sourceLocale: options.sourceLocale || 'en',
      targetLocales: options.targetLocales || ['es', 'fr', 'ar', 'pt', 'de', 'ru', 'ja', 'it'],
      engineUrl: options.engineUrl || process.env.LIBRETRANSLATE_URL || 'http://127.0.0.1:5000',
      apiKey: options.apiKey || process.env.LIBRETRANSLATE_API_KEY,
      isLive: options.isLive ?? true,
      includeVersions: options.includeVersions ?? false,
      onlyTables: options.onlyTables,
      onProgress: options.onProgress,
      connectionString: options.connectionString || process.env.DATABASE_URL,
    }
  }

  private updateProgress(patch: Partial<BulkProgress>): void {
    this.currentProgress = { ...this.currentProgress, ...patch }
    if (this.options.onProgress) {
      this.options.onProgress(this.currentProgress)
    }
  }

  private async queryWithRetry(sql: string, params?: any[], maxRetries = 5): Promise<any> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.pool!.query({ text: sql, values: params, query_timeout: 120000 } as any)
      } catch (err: any) {
        console.warn(`[auto-translate] DB query retry ${attempt}/${maxRetries} (${err.message})...`)
        if (attempt === maxRetries) throw err
        await new Promise((r) => setTimeout(r, attempt * 1500))
      }
    }
  }

  public async run(): Promise<BulkProgress> {
    const connStr = this.options.connectionString || process.env.DATABASE_URL
    if (!connStr) {
      throw new Error('[auto-translate] DATABASE_URL is not configured')
    }

    this.pool = new Pool({
      connectionString: connStr,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 60000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      statement_timeout: 120000,
    })

    this.pool.on('error', (err) => {
      console.warn('[auto-translate] Idle client disconnected (automatically purged from pool):', err.message)
    })

    const sourceLocale = this.options.sourceLocale!
    const targetLocales = this.options.targetLocales!
    const engineUrl = this.options.engineUrl!
    const isLive = this.options.isLive!
    const includeVersions = this.options.includeVersions !== false

    this.updateProgress({
      status: 'running',
      startTime: Date.now(),
      totalTables: 0,
      processedTables: 0,
      totalStrings: 0,
      translatedStrings: 0,
      failedStrings: 0,
      insertedRows: 0,
      updatedRows: 0,
      skippedRows: 0,
    })

    try {
      // 1. Discover all tables that have a _locale column
      const tablesRes = await this.queryWithRetry(`
        SELECT DISTINCT table_name 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND column_name = '_locale'
        ORDER BY table_name
      `)

      let tables: string[] = tablesRes.rows
        .map((r: any) => r.table_name)
        .filter((t: string) => !t.startsWith('_') || (includeVersions && t.includes('_v_')))

      if (this.options.onlyTables && this.options.onlyTables.length > 0) {
        tables = tables.filter((t) =>
          this.options.onlyTables!.some((ot: string) => t === ot || t.startsWith(`${ot}_`)),
        )
      }

      // Foreign key parent mapping
      const fkRes = await this.queryWithRetry(`
        SELECT
          conrelid::regclass::text AS child_table,
          confrelid::regclass::text AS parent_table
        FROM pg_constraint
        WHERE contype = 'f' AND connamespace = 'public'::regnamespace
      `)
      const childToParentTableMap = new Map<string, string>()
      for (const r of fkRes.rows) {
        const child = r.child_table.replace(/^"|"$/g, '')
        const parent = r.parent_table.replace(/^"|"$/g, '')
        childToParentTableMap.set(child, parent)
      }

      // Columns metadata
      const allColsRes = await this.queryWithRetry(`
        SELECT table_name, column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public'
      `)
      const tableColumnsMap = new Map<string, { name: string; type: string }[]>()
      for (const r of allColsRes.rows) {
        if (!tableColumnsMap.has(r.table_name)) {
          tableColumnsMap.set(r.table_name, [])
        }
        tableColumnsMap.get(r.table_name)!.push({ name: r.column_name, type: r.data_type })
      }

      this.updateProgress({ totalTables: tables.length })
      console.log(`[auto-translate] 📋 Found ${tables.length} localized tables to scan.`)

      let processedCount = 0

      for (const table of tables) {
        processedCount++
        this.updateProgress({ processedTables: processedCount, currentTable: table })

        try {
          const columns = tableColumnsMap.get(table) || []
          const parentTable = childToParentTableMap.get(table)
          const parentIsLocalized = parentTable ? tables.includes(parentTable) : false

          const allRows: any[] = []
          const hasIdColumn = columns.some((c) => c.name === 'id')
          if (hasIdColumn) {
            const batchSize = 100
            let afterId: any = undefined
            for (;;) {
              const batch =
                afterId === undefined
                  ? await this.queryWithRetry(`SELECT * FROM "${table}" ORDER BY "id" LIMIT ${batchSize}`)
                  : await this.queryWithRetry(`SELECT * FROM "${table}" WHERE "id" > $1 ORDER BY "id" LIMIT ${batchSize}`, [afterId])
              allRows.push(...batch.rows)
              if (batch.rows.length < batchSize) break
              afterId = batch.rows[batch.rows.length - 1].id
            }
          } else {
            const allRowsRes = await this.queryWithRetry(`SELECT * FROM "${table}"`)
            allRows.push(...allRowsRes.rows)
          }

          const sourceRows: any[] = []
          const existingRowsById = new Map<string, any>()
          const existingRowsByUuid = new Map<string, any>()
          const existingRowsByParent = new Map<string, any>()

          for (const r of allRows) {
            if (r._locale === sourceLocale) {
              sourceRows.push(r)
            }
            if (typeof r.id === 'string') {
              existingRowsById.set(r.id, r)
            }
            if (typeof r._uuid === 'string' && r._locale) {
              existingRowsByUuid.set(`${r._uuid}_${r._locale}`, r)
            }
            if (r._parent_id !== undefined && r._locale) {
              existingRowsByParent.set(`${r._parent_id}_${r._locale}`, r)
            }
          }

          if (sourceRows.length === 0) {
            continue
          }

          const findTargetRow = (sourceRow: any, targetLocale: string) => {
            const isIdString = typeof sourceRow.id === 'string'
            const isParentIdString = typeof sourceRow._parent_id === 'string'
            const targetId = isIdString ? `${sourceRow.id}_${targetLocale}` : null
            const targetUuid = typeof sourceRow._uuid === 'string' ? `${sourceRow._uuid}_${targetLocale}` : null
            const targetParentId =
              sourceRow._parent_id !== undefined
                ? isParentIdString && parentIsLocalized
                  ? `${sourceRow._parent_id}_${targetLocale}`
                  : sourceRow._parent_id
                : null
            if (isIdString && targetId) return existingRowsById.get(targetId)
            if (targetUuid) return existingRowsByUuid.get(`${targetUuid}`)
            if (sourceRow._parent_id !== undefined) return existingRowsByParent.get(`${targetParentId}_${targetLocale}`)
            return undefined
          }

          // Find which target locales need translation
          const localesNeedingTranslation: string[] = []
          for (const targetLocale of targetLocales) {
            const isNeeded = sourceRows.some((sourceRow) => {
              const existing = findTargetRow(sourceRow, targetLocale)
              if (!existing) return true
              return sourceRowHasUntranslatedFields(sourceRow, existing, columns)
            })
            if (isNeeded) {
              localesNeedingTranslation.push(targetLocale)
            }
          }

          if (localesNeedingTranslation.length === 0) {
            this.updateProgress({
              skippedRows: (this.currentProgress.skippedRows || 0) + sourceRows.length * targetLocales.length,
            })
            continue
          }

          // Collect only strings whose target fields still need writing, per locale
          const stringsByLocale = new Map<string, Set<string>>()
          for (const targetLocale of localesNeedingTranslation) {
            stringsByLocale.set(targetLocale, new Set<string>())
          }
          const collectLexical = (localeSet: Set<string>, val: any) => {
            if (isLexicalNode(val)) {
              const leaves = extractLexicalTextNodes(val)
              for (const str of leaves.values()) {
                if (!shouldSkipValue(str)) localeSet.add(str)
              }
            }
          }
          for (const targetLocale of localesNeedingTranslation) {
            const localeSet = stringsByLocale.get(targetLocale)!
            for (const sourceRow of sourceRows) {
              const existing = findTargetRow(sourceRow, targetLocale)
              if (!existing) {
                for (const col of columns) {
                  if (!isTranslatableColumn(col)) continue
                  const val = sourceRow[col.name]
                  if (col.type === 'jsonb' || col.type === 'json') {
                    collectLexical(localeSet, val)
                  } else if (typeof val === 'string' && val.trim() && !shouldSkipValue(val)) {
                    localeSet.add(val)
                  }
                }
                continue
              }
              for (const col of columns) {
                if (!isTranslatableColumn(col)) continue
                const cur = existing[col.name]
                const val = sourceRow[col.name]
                if (col.type === 'jsonb' || col.type === 'json') {
                  if (
                    val &&
                    (!cur ||
                      JSON.stringify(cur) === JSON.stringify(val) ||
                      hasUntranslatedLexicalNodes(val, cur))
                  ) {
                    collectLexical(localeSet, val)
                  }
                } else if (typeof val === 'string' && val.trim() && !shouldSkipValue(val)) {
                  if (!cur || cur === val) localeSet.add(val)
                }
              }
            }
          }

          const perLocaleCounts = localesNeedingTranslation.map(
            (l) => `${l}:${stringsByLocale.get(l)!.size}`,
          )
          this.updateProgress({
            totalStrings:
              (this.currentProgress.totalStrings || 0) +
              localesNeedingTranslation.reduce((sum, l) => sum + stringsByLocale.get(l)!.size, 0),
          })

          console.log(
            `[auto-translate] Processing ${table}: ${sourceRows.length} source rows, ${perLocaleCounts.join(' ')}...`,
          )

          const localesToRun = targetLocales
            .filter((l) => localesNeedingTranslation.includes(l))
            .filter((l) => (stringsByLocale.get(l)?.size ?? 0) > 0)
          let localeCursor = 0
          const runLocale = async (targetLocale: string): Promise<void> => {
            const localeStrings = Array.from(stringsByLocale.get(targetLocale) || [])
            if (localeStrings.length === 0) return

            const translationMap = await translateBatchViaLibre(
              localeStrings,
              targetLocale,
              sourceLocale,
              engineUrl,
              this.options.apiKey,
              15,
              3,
              // Increment counter per chunk so progress is visible in real time
              (succeededCount, failedCount) => {
                this.updateProgress({
                  translatedStrings: (this.currentProgress.translatedStrings || 0) + succeededCount,
                  failedStrings: (this.currentProgress.failedStrings || 0) + (failedCount || 0),
                })
              },
            )

            // Update / Insert rows into table
            for (const sourceRow of sourceRows) {
              const isIdString = typeof sourceRow.id === 'string'
              const isParentIdString = typeof sourceRow._parent_id === 'string'
              const targetId = isIdString ? `${sourceRow.id}_${targetLocale}` : null
              const targetUuid = typeof sourceRow._uuid === 'string' ? `${sourceRow._uuid}_${targetLocale}` : null
              const targetParentId =
                sourceRow._parent_id !== undefined
                  ? isParentIdString && parentIsLocalized
                    ? `${sourceRow._parent_id}_${targetLocale}`
                    : sourceRow._parent_id
                  : null

              let existingRow: any = null
              if (isIdString && targetId) {
                existingRow = existingRowsById.get(targetId) || null
              } else if (targetUuid) {
                existingRow = existingRowsByUuid.get(`${sourceRow._uuid}_${targetLocale}`) || null
              } else if (sourceRow._parent_id !== undefined) {
                existingRow = existingRowsByParent.get(`${targetParentId}_${targetLocale}`) || null
              }

              if (existingRow) {
                // Update existing row
                const updates: Record<string, any> = {}
                let needsUpdate = false

                for (const col of columns) {
                  if (!isTranslatableColumn(col)) continue
                  const cur = existingRow[col.name]
                  const src = sourceRow[col.name]

                  if (col.type === 'jsonb' || col.type === 'json') {
                    if (
                      src &&
                      (!cur ||
                        JSON.stringify(cur) === JSON.stringify(src) ||
                        hasUntranslatedLexicalNodes(src, cur))
                    ) {
                      updates[col.name] = applyLexicalTranslations(src, translationMap)
                      needsUpdate = true
                    }
                  } else if (typeof src === 'string' && src.trim() && !shouldSkipValue(src)) {
                    if (!cur || cur === src) {
                      updates[col.name] = translationMap.get(src) || src
                      needsUpdate = true
                    }
                  }
                }

                if (needsUpdate && isLive) {
                  const setClauses: string[] = []
                  const values: any[] = []
                  let idx = 1
                  for (const [k, v] of Object.entries(updates)) {
                    setClauses.push(`"${k}" = $${idx++}`)
                    values.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v)
                  }

                  if (existingRow.id !== undefined) {
                    values.push(existingRow.id)
                    await this.queryWithRetry(
                      `UPDATE "${table}" SET ${setClauses.join(', ')} WHERE "id" = $${idx}`,
                      values,
                    )
                  } else if (sourceRow._parent_id !== undefined) {
                    values.push(targetParentId, targetLocale)
                    await this.queryWithRetry(
                      `UPDATE "${table}" SET ${setClauses.join(', ')} WHERE "_parent_id" = $${idx++} AND "_locale" = $${idx}`,
                      values,
                    )
                  }
                  this.updateProgress({ updatedRows: (this.currentProgress.updatedRows || 0) + 1 })
                }
              } else {
                // Insert new localized row
                const newRow: Record<string, any> = {}
                for (const col of columns) {
                  const colName = col.name
                  const srcVal = sourceRow[colName]

                  if (colName === '_locale') {
                    newRow[colName] = targetLocale
                  } else if (colName === 'id' && isIdString) {
                    newRow[colName] = targetId
                  } else if (colName === '_uuid' && typeof srcVal === 'string' && srcVal.trim()) {
                    newRow[colName] = srcVal.endsWith(`_${targetLocale}`) ? srcVal : `${srcVal}_${targetLocale}`
                  } else if (colName === '_parent_id') {
                    newRow[colName] = targetParentId
                  } else if (colName === 'published_locale') {
                    newRow[colName] = targetLocale
                  } else if (col.type === 'jsonb' || col.type === 'json') {
                    newRow[colName] = srcVal ? applyLexicalTranslations(srcVal, translationMap) : srcVal
                  } else if (typeof srcVal === 'string' && srcVal.trim() && isTranslatableColumn(col)) {
                    newRow[colName] = translationMap.get(srcVal) || srcVal
                  } else {
                    newRow[colName] = srcVal
                  }
                }

                if (isLive) {
                  const colNames = Object.keys(newRow).filter((k) => k !== 'id' || isIdString)
                  const colSql = colNames.map((c) => `"${c}"`).join(', ')
                  const valPlaceholders = colNames.map((_, i) => `$${i + 1}`).join(', ')
                  const values = colNames.map((c) => {
                    const v = newRow[c]
                    return typeof v === 'object' && v !== null ? JSON.stringify(v) : v
                  })

                  await this.queryWithRetry(
                    `INSERT INTO "${table}" (${colSql}) VALUES (${valPlaceholders}) ON CONFLICT DO NOTHING;`,
                    values,
                  )
                }
                this.updateProgress({ insertedRows: (this.currentProgress.insertedRows || 0) + 1 })
              }
            }
            // Brief 50ms yield between locales to give CPU and socket breathing room
            await new Promise((r) => setTimeout(r, 50))
          }
          const workerCount = Math.min(4, localesToRun.length)
          let workerCursor = 0
          await Promise.all(
            Array.from({ length: workerCount }, async () => {
              while (workerCursor < localesToRun.length) {
                const targetLocale = localesToRun[workerCursor++]
                await runLocale(targetLocale)
              }
            }),
          )
        } catch (tableErr: any) {
          console.error(`[auto-translate] ⚠️ Error on table ${table}: ${tableErr.message}. Skipping...`)
          this.updateProgress({
            skippedRows: (this.currentProgress.skippedRows || 0) + 1,
          })
        }
      }

      this.updateProgress({
        status: 'completed',
        endTime: Date.now(),
      })
      console.log(`[auto-translate] 🎉 Bulk database translation finished successfully!`)
      return this.currentProgress
    } catch (err: any) {
      this.updateProgress({
        status: 'failed',
        endTime: Date.now(),
        error: err.message,
      })
      throw err
    } finally {
      if (this.pool) {
        await this.pool.end()
      }
    }
  }
}

function isTranslatableColumn(col: { name: string; type: string }): boolean {
  if (!isTranslatableField(col.name)) return false
  return ['character varying', 'text', 'jsonb', 'json'].includes(col.type)
}

function sourceRowHasUntranslatedFields(
  src: any,
  cur: any,
  columns: { name: string; type: string }[],
): boolean {
  for (const col of columns) {
    if (!isTranslatableColumn(col)) continue
    if (fieldNeedsTranslation(src[col.name], cur[col.name], col)) return true
  }
  return false
}

function fieldNeedsTranslation(src: any, cur: any, col: { name: string; type: string }): boolean {
  if (col.type === 'jsonb' || col.type === 'json') {
    if (!src) return false
    if (!cur || JSON.stringify(cur) === JSON.stringify(src)) {
      return hasTranslatableLexicalText(src)
    }
    return hasUntranslatedLexicalNodes(src, cur)
  }
  if (typeof src === 'string' && src.trim() && !shouldSkipValue(src)) {
    return !cur || cur === src
  }
  return false
}

function hasTranslatableLexicalText(node: any): boolean {
  if (!isLexicalNode(node)) return false
  for (const str of extractLexicalTextNodes(node).values()) {
    if (!shouldSkipValue(str)) return true
  }
  return false
}

function hasUntranslatedLexicalNodes(src: any, cur: any): boolean {
  if (!isLexicalNode(src)) return false
  if (!cur || !isLexicalNode(cur)) return true
  const curTexts = new Set(extractLexicalTextNodes(cur).values())
  for (const str of extractLexicalTextNodes(src).values()) {
    if (shouldSkipValue(str)) continue
    if (str.length >= 20 && str.includes(' ') && curTexts.has(str)) return true
  }
  return false
}

function applyLexicalTranslations(node: any, map: Map<string, string>): any {
  if (Array.isArray(node)) {
    return node.map((item) => applyLexicalTranslations(item, map))
  } else if (node && typeof node === 'object') {
    const copy: any = { ...node }
    if (copy.type === 'text' && typeof copy.text === 'string' && copy.text.trim()) {
      copy.text = map.get(copy.text) || copy.text
    }
    for (const k of Object.keys(copy)) {
      copy[k] = applyLexicalTranslations(copy[k], map)
    }
    return copy
  }
  return node
}
