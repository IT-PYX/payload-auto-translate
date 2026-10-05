<div align="center">

<h1 align="center">payload-auto-translate</h1>

[![npm version](https://img.shields.io/npm/v/@itpyx/payload-auto-translate.svg?style=flat-square)](https://www.npmjs.com/package/@itpyx/payload-auto-translate)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Payload CMS 3.x](https://img.shields.io/badge/Payload%20CMS-3.x-black?style=flat-square&logo=payloadcms)](https://payloadcms.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)

<br />

**High-performance automated multi-language translation plugin for [Payload CMS 3.x](https://payloadcms.com/)**

*Real-time background sync, Lexical Rich Text AST preservation, SEO slugification, and high-speed PostgreSQL bulk database crawler powered by [LibreTranslate](https://libretranslate.com/).*

</div>

---

## Overview

Payload CMS provides an excellent schema localization engine (`localized: true`), but it does not translate content out of the box—editors typically have to duplicate and translate content by hand.

`@itpyx/payload-auto-translate` automates the entire localization lifecycle:
1. **Real-Time Active Sync**: Whenever an editor creates or edits content in the source locale (e.g., English), background workers automatically translate all target locales with debouncing.
2. **SEO-Grade Slug Localization**: Automatically generates clean URL slugs (`inverter-split-ac` -> `climatiseur-split-inverter` in French, `aire-acondicionado-split-inverter` in Spanish) with German umlaut expansion and non-Latin character safety.
3. **Smart Array & Block Merging**: Intelligently preserves existing human-edited blocks, updates modified copy, and appends newly added blocks without mashing mismatched `blockType`s.
4. **Lexical Rich Text AST Preservation**: Traverses Lexical JSON text leaves while keeping headings, links, tables, and custom blocks structurally intact.
5. **Direct PostgreSQL Bulk Crawler**: Includes a standalone CLI tool that crawls PostgreSQL tables directly, backfilling millions of words across existing websites in minutes with zero API overhead.

> 📖 **Full Guide**: For a complete walkthrough of configuring environment variables, Next.js transpilation, CLI backfill, and production Docker setups, see the [Comprehensive Integration Guide](docs/INTEGRATION_GUIDE.md).

---

## Requirements

- **Payload CMS**: `^3.0.0`
- **Database**: PostgreSQL (via `@payloadcms/db-postgres`)
- **Node.js**: `>=18.20.0` or `>=20.9.0`
- **LibreTranslate**: Self-hosted or dedicated LibreTranslate instance

---

## Installation

```bash
pnpm add @itpyx/payload-auto-translate pg dotenv
# or
npm install @itpyx/payload-auto-translate pg dotenv
# or
yarn add @itpyx/payload-auto-translate pg dotenv
```

---

## Quickstart

### 1. Register Plugin in `payload.config.ts`

```typescript
import { buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { autoTranslatePlugin } from '@itpyx/payload-auto-translate'

export default buildConfig({
  localization: {
    locales: [
      { label: 'English', code: 'en' },
      { label: 'Español', code: 'es' },
      { label: 'Français', code: 'fr' },
      { label: 'Deutsch', code: 'de' },
      { label: 'العربية', code: 'ar' },
      { label: '日本語', code: 'ja' },
    ],
    defaultLocale: 'en',
    fallback: true,
  },
  db: postgresAdapter({
    pool: { connectionString: process.env.DATABASE_URL },
  }),
  plugins: [
    autoTranslatePlugin({
      engine: {
        url: process.env.LIBRETRANSLATE_URL || 'http://127.0.0.1:5000',
        apiKey: process.env.LIBRETRANSLATE_API_KEY,
      },
      sourceLocale: 'en',
      targetLocales: ['es', 'fr', 'de', 'ar', 'ja'],
      activeTranslation: {
        enabled: true,
        concurrency: 2,
        triggerOn: ['create', 'update'],
        translateDrafts: true, // Preserves draft status in collections with versions
      },
      // Optional: Automatic SEO slug translation
      slug: {
        enabled: true,         // Enable automatic translated slugs
        latinLocalesOnly: true // Preserves clean ASCII slugs for non-Latin (ar, ja)
      },
      // Optional: Configure specific collections
      collections: {
        pages: true,
        blog: {
          translateSlug: true,
          excludedFields: ['authorNotes', 'internalReview'],
        },
      },
    }),
  ],
})
```

### 2. Configure Environment Variables

Add to your `.env`:

```env
LIBRETRANSLATE_URL=http://your-vps-ip:5000
LIBRETRANSLATE_API_KEY=your_optional_api_key
```

### 3. Next.js App Router (Payload 3.x)

If your CMS runs within Next.js, add the package to `transpilePackages` in `next.config.mjs`:

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@itpyx/payload-auto-translate'],
}
export default nextConfig
```

---

## Configuration Reference

### `autoTranslatePlugin(options)`

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `engine.url` | `string` | `process.env.LIBRETRANSLATE_URL` \|\| `'http://127.0.0.1:5000'` | Base URL of your LibreTranslate instance. |
| `engine.apiKey` | `string` | `process.env.LIBRETRANSLATE_API_KEY` | Optional API key if your LibreTranslate server requires authentication. |
| `sourceLocale` | `string` | Payload `defaultLocale` \|\| `'en'` | The master locale from which translations are generated. |
| `targetLocales` | `string[]` | All other configured locales | Array of target language codes to translate into. |
| `activeTranslation.enabled` | `boolean` | `true` | Enables real-time background translation on editorial save. |
| `activeTranslation.concurrency` | `number` | `2` | Number of concurrent documents processed in the queue. |
| `activeTranslation.triggerOn` | `('create' \| 'update')[]` | `['create', 'update']` | Operations that trigger background translation. |
| `activeTranslation.translateDrafts` | `boolean` | `true` | Translates drafts without prematurely publishing them. |
| `slug.enabled` | `boolean` | `false` | Enable automatic SEO slug generation for localized documents. |
| `slug.latinLocalesOnly` | `boolean` | `true` | If true, only translates slugs for Latin locales (es, fr, de, it, pt) and preserves ASCII slugs for non-Latin (ar, ru, ja). |
| `slug.sourceField` | `string` | `'title'` | Field to derive slug from (falls back to `'name'`). |
| `slug.slugify` | `function` | Built-in SEO slugifier | Custom function: `(title, locale, currentSlug) => string`. |
| `customFieldExclusions` | `string[]` | `[]` | Field names to exclude from translation globally. |
| `customValueExclusions` | `string[]` | `[]` | Specific text strings to skip during translation globally. |
| `customValuePatterns` | `(string \| RegExp)[]` | `[]` | Custom regex patterns or strings to skip during translation (e.g. hardware specs like `[/^IP\d+/, /^RS-?485/i]`). |
| `fallbackRetry` | `FallbackRetryOptions` | `{ enabled: false }` | Optional fallback retry for strings returning untranslated (e.g., Title Cased headlines). |
| `collections` | `Record<string, boolean \| CollectionConfigOptions>` | Auto-detected | Selectively enable, exclude fields, or toggle slug translation per collection. |
| `globals` | `Record<string, boolean \| CollectionConfigOptions>` | Auto-detected | Selectively enable or exclude fields per global. |
| `disabled` | `boolean` | `false` | Master kill-switch to temporarily disable the plugin. |

---

## Slug Translation Features

When `slug.enabled: true` is set (or `translateSlug: true` on a specific collection):

1. **German Umlaut Expansion**: Automatically maps `ä -> ae`, `ö -> oe`, `ü -> ue`, `ß -> ss` (e.g. `Lüftungstechnik Köln` -> `lueftungstechnik-koeln`).
2. **Accents & Diacritics**: Automatically strips accents across French, Spanish, Italian, and Portuguese (`Climatisation Écologique` -> `climatisation-ecologique`).
3. **Non-Latin Protection**: When `latinLocalesOnly: true` (default), non-Latin languages (`ar`, `ja`, `ru`, `zh`) safely preserve the base ASCII slug, avoiding broken percent-encoded URLs (`%D8%A7%D9%84%D...`). When set to `false`, clean Unicode characters are preserved.
4. **Human Edit Protection**: Only generates a translated slug if the target slug is empty or identical to the default source English slug. Manually customized slugs are never overwritten.

---

## Bulk Database Crawler (CLI)

For initial migrations, importing large catalogs, or translating existing records, use the standalone Database Crawler. It connects directly to PostgreSQL via raw SQL, inspects all tables with a `_locale` column, and populates missing target rows in high-speed parallel batches.

### CLI Usage

```bash
# 1. Dry run (inspect translatable tables and strings without writing to the database):
pnpm payload-auto-translate

# 2. Live migration (writes translated records directly to PostgreSQL):
pnpm payload-auto-translate --live

# 3. Limit translation to specific tables:
pnpm payload-auto-translate --live --tables=pages,products

# 4. Enable fallback retry for Title Case / Headline echoes:
pnpm payload-auto-translate --live --fallback-retry --fallback-strategy=sentence-case

# 5. Skip domain-specific tokens or hardware specs via patterns:
pnpm payload-auto-translate --live --value-patterns="/^IP\d+$/i,/^RS-?485$/i"

# 6. Custom .env file path:
pnpm payload-auto-translate --live --env=/path/to/.env
```

Add helper scripts to your CMS `package.json`:

```json
{
  "scripts": {
    "translate:dry": "payload-auto-translate",
    "translate:bulk": "payload-auto-translate --live"
  }
}
```

---

## Built-in REST Endpoints

The plugin exposes secure, authenticated endpoints under your Payload API router:

* `GET /api/auto-translate/status`: Returns LibreTranslate connectivity, supported language codes, active queue stats, and bulk crawler progress.
* `POST /api/auto-translate/start-bulk`: Asynchronously triggers a bulk migration across all localized tables.
* `GET /api/auto-translate/bulk-progress`: Polls live migration progress (tables processed, total strings, translated strings, inserted/updated counts).

---

## Self-Hosting LibreTranslate (Docker)

To run your own free, unlimited translation instance on your server using Docker:

```bash
docker run -d \
  --name libretranslate \
  -p 5000:5000 \
  --restart unless-stopped \
  libretranslate/libretranslate:latest \
  --load-only en,es,fr,de,ar,pt,ru,ja
```

---

## License

MIT License. Copyright (c) 2026 IT-PYX.
