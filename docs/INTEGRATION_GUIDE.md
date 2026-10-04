# Payload Auto-Translate Plugin Integration Guide
**Package**: [`@itpyx/payload-auto-translate`](https://www.npmjs.com/package/@itpyx/payload-auto-translate)  
**Supported Stack**: Payload CMS 3.x, PostgreSQL (`@payloadcms/db-postgres`), Next.js (App Router), LibreTranslate  

---

## 1. Overview & Architecture

Payload CMS provides built-in schema localization (`localized: true`), which creates separate database tables/columns for each configured language (e.g. `pages_locales`, `blog_locales`). However, Payload does **not** translate content out of the box—editors typically have to duplicate and translate content manually across every locale.

`@itpyx/payload-auto-translate` automates the entire localization lifecycle with two complementary operating modes:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   @itpyx/payload-auto-translate                        │
├───────────────────────────────────┬────────────────────────────────────┤
│ 1. Real-Time Hook Mode            │ 2. PostgreSQL Bulk Crawler CLI     │
│ - Attached via afterChange hooks  │ - Direct pg connection             │
│ - Debounced background queue      │ - Batch table scanner              │
│ - Runs on admin create & update   │ - Fast backfill for existing DBs   │
│ - Lexical AST rich text leaves    │ - Zero API overhead (1000s docs/m) │
└───────────────────────────────────┴────────────────────────────────────┘
```

### Key Capabilities
- **Real-Time Active Sync**: Whenever an editor creates or edits a document in the source language (e.g., English), background workers automatically queue and translate all target locales with debouncing.
- **Smart Array & Block Merging**: Intelligently preserves existing human-edited blocks, updates modified fields, and appends newly added blocks without mashing mismatched `blockType`s.
- **Lexical AST Preservation**: Traverses Lexical JSON text leaves while keeping headings, links, formatting, and custom blocks structurally intact.
- **SEO-Grade Slug Localization**: Automatically generates clean URL slugs with German umlaut expansion (`ä` -> `ae`), diacritic normalization, and non-Latin character safety.
- **PostgreSQL Bulk Crawler CLI**: Standalone high-speed scanner that connects directly to PostgreSQL, backfilling millions of words across existing websites in minutes without saturating the Node API.
- **Zero Primary Key Collisions**: Automatic idempotent string ID suffixing (`id_es`) and numeric sequence handling for layout blocks.

---

## 2. Prerequisites & Requirements

- **Payload CMS**: Version `^3.0.0` (tested through `3.88.x`).
- **Database**: PostgreSQL with `@payloadcms/db-postgres`.
- **Node.js**: `>=18.20.0` or `>=20.9.0` (Node 20 or 22 recommended).
- **LibreTranslate**: A running LibreTranslate instance (self-hosted via Docker or VPS).

---

## 3. Step 1: Install the Package

In your Payload CMS project (or `apps/cms` in a monorepo), install the plugin along with `pg` and `dotenv`:

```bash
# Using pnpm (recommended)
pnpm add @itpyx/payload-auto-translate pg dotenv

# Using npm
npm install @itpyx/payload-auto-translate pg dotenv

# Using yarn
yarn add @itpyx/payload-auto-translate pg dotenv
```

---

## 4. Step 2: Environment Variables (`.env`)

Add the translation engine endpoint and credentials to your `.env` file:

```env
# Database connection
DATABASE_URL=postgres://user:password@host:5432/your_database_name

# LibreTranslate Engine
LIBRETRANSLATE_URL=https://translate.yourdomain.com
# Optional: only required if your LibreTranslate instance requires an API key
LIBRETRANSLATE_API_KEY=your_libretranslate_api_key_here
```

> [!TIP]
> If running LibreTranslate locally via Docker, the URL is typically `http://127.0.0.1:5000` without an API key.

---

## 5. Step 3: Configure `payload.config.ts`

Import and register `autoTranslatePlugin` in your `plugins` array.

### Standard Configuration

```typescript
import { buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { autoTranslatePlugin } from '@itpyx/payload-auto-translate'

export default buildConfig({
  // 1. Define your locales
  localization: {
    locales: [
      { label: 'English', code: 'en' },
      { label: 'Español', code: 'es' },
      { label: 'Français', code: 'fr' },
      { label: 'Deutsch', code: 'de' },
      { label: 'Italiano', code: 'it' },
      { label: 'Português', code: 'pt' },
      { label: 'العربية', code: 'ar' },
      { label: 'Русский', code: 'ru' },
      { label: '日本語', code: 'ja' },
    ],
    defaultLocale: 'en',
    fallback: true,
  },

  // 2. Register the plugin
  plugins: [
    autoTranslatePlugin({
      // Engine configuration
      engine: {
        url: process.env.LIBRETRANSLATE_URL || 'http://127.0.0.1:5000',
        apiKey: process.env.LIBRETRANSLATE_API_KEY,
      },

      // Source and target languages
      sourceLocale: 'en',
      targetLocales: ['es', 'fr', 'de', 'it', 'pt', 'ar', 'ru', 'ja'],

      // Real-time background sync on CMS save
      activeTranslation: {
        enabled: true,
        concurrency: 2, // Max concurrent translations
        triggerOn: ['create', 'update'],
      },

      // Collections to translate
      collections: {
        pages: true,
        blog: true,
        products: true,
        solutions: true,
        // Explicitly exclude non-content collections:
        users: false,
        media: false,
        'contact-submissions': false,
      },

      // Globals to translate
      globals: {
        settings: {
          excludedFields: ['socials', 'googleAnalyticsId'],
        },
        header: true,
        footer: true,
      },

      // Optional: Automated SEO URL slug translation
      slug: {
        enabled: true,
        latinLocalesOnly: true, // Translates es, fr, de, it, pt; preserves clean ASCII for ar, ja, ru
        sourceField: 'title',   // Derives slug from translated title (falls back to 'name')
      },

      // Global exclusions across all collections
      customFieldExclusions: ['trackingCode', 'externalId'],
    }) as any,
  ],
})
```

---

## 6. Step 4: Next.js Configuration (`next.config.ts`)

In Next.js App Router projects, transpilation of the ESM plugin package must be enabled:

```typescript
// next.config.ts
import { withPayload } from '@payloadcms/next/withPayload'

const nextConfig = {
  reactStrictMode: false,
  output: 'standalone' as const,
  transpilePackages: ['@itpyx/payload-auto-translate'],
}

export default withPayload(nextConfig)
```

---

## 7. Step 5: Initial Database Backfill via CLI

When integrating into an existing project with already-published English content, you don't need editors to manually click "Save" on every document. Use the built-in CLI to crawl the database directly.

### 1. Dry Run (Preview Changes Safely)

Scans the database and shows a detailed report of missing or untranslated rows without making any database writes:

```bash
npx payload-auto-translate --db="$DATABASE_URL" --url="$LIBRETRANSLATE_URL" --key="$LIBRETRANSLATE_API_KEY"
```

### 2. Live Migration (Executes Translations & Database Updates)

Add the `--live` flag to translate and write changes directly to PostgreSQL:

```bash
npx payload-auto-translate --live --db="$DATABASE_URL" --url="$LIBRETRANSLATE_URL" --key="$LIBRETRANSLATE_API_KEY"
```

### 3. Crawl Specific Tables

To restrict the crawler to specific collections or block tables:

```bash
npx payload-auto-translate --live --tables=pages,pages_blocks_hero,blog
```

### CLI Options Reference

| Argument | Description | Default |
| :--- | :--- | :--- |
| `--live` | Execute database updates (otherwise dry-run preview) | `false` |
| `--db=<url>` | PostgreSQL connection string | `DATABASE_URL` from `.env` |
| `--url=<url>` | LibreTranslate API endpoint | `LIBRETRANSLATE_URL` from `.env` |
| `--key=<key>` | LibreTranslate API key | `LIBRETRANSLATE_API_KEY` from `.env` |
| `--env=<path>` | Custom path to `.env` file | `.env` in current directory |
| `--source=<code>` | Source language code | `en` |
| `--targets=<c1,c2>` | Comma-separated target locale codes | All non-source locales |
| `--tables=<t1,t2>` | Comma-separated table names to include | All `_locales` tables |
| `--versions` | Include historical version tables | `false` |

---

## 8. Step 6: REST API Endpoints

The plugin automatically mounts three administrative REST endpoints under `/api/auto-translate/*`:

### 1. Health & Queue Status
```http
GET /api/auto-translate/status
```
Returns active queue length, worker status, and engine connectivity.

### 2. Trigger Background Bulk Job
```http
POST /api/auto-translate/start-bulk
Content-Type: application/json

{
  "tables": ["pages", "products"],
  "isLive": true
}
```

### 3. Stream Bulk Progress
```http
GET /api/auto-translate/bulk-progress
```
Streams real-time progress stats (tables processed, strings translated, rows updated).

> [!IMPORTANT]
> All `/api/auto-translate/*` endpoints require authentication. Unauthenticated requests will return `401 Unauthorized`. To call them, supply the standard Payload JWT cookie or `Authorization: JWT <token>` header.

---

## 9. Advanced Configuration Options

### Plugin Options Table

```typescript
export interface AutoTranslatePluginOptions {
  engine?: {
    type?: 'libretranslate'
    url?: string
    apiKey?: string
  }
  sourceLocale?: string              // default: 'en'
  targetLocales?: string[]           // default: all other configured locales
  activeTranslation?: {
    enabled?: boolean               // default: true
    onlySourceLocale?: boolean      // default: true (only triggers when editing source locale)
    triggerOn?: ('create' | 'update')[]
    concurrency?: number            // default: 2
  }
  slug?: {
    enabled?: boolean               // default: false
    latinLocalesOnly?: boolean      // default: true
    sourceField?: string            // default: 'title'
    slugify?: (title: string, locale: string, currentSlug?: string) => string
  }
  customFieldExclusions?: string[]  // field names to skip globally
  customValueExclusions?: string[]  // exact string values to skip
  collections?: Record<string, boolean | CollectionConfigOptions>
  globals?: Record<string, boolean | CollectionConfigOptions>
  bulk?: {
    onlyTables?: string[]
    includeVersions?: boolean
  }
  disabled?: boolean
}
```

---

## 10. Best Practices & Safety Rules

1. **Keep `localized: true` on fields to translate**:
   Payload only creates database locale columns for fields marked `localized: true`. System fields like `id`, `createdAt`, and `updatedAt` are automatically skipped.

2. **Slug Localization Protocol**:
   If you localize the `slug` field (`localized: true`), **never** run a direct auto-generated Payload migration that drops the root `slug` column before data is preserved. Follow the 3-phase migration rule:
   - Phase A: Add `slug` column to `collection_locales`.
   - Phase B: Backfill existing locale rows from root `slug`.
   - Phase C: Add compound unique index `("_locale", "slug")` and drop old root column.

3. **Handling Human Edits**:
   The plugin uses a **merge-preserving algorithm**. If a human editor manually refines a translated field in Spanish, saving the English version later will **not** overwrite the human Spanish translation unless the Spanish field was empty.

4. **Docker Production Deployment**:
   In your production `Dockerfile`, you only need standard `pnpm install`—no custom local workspace build steps are required:
   ```dockerfile
   COPY pnpm-lock.yaml package.json ./
   COPY apps/cms ./apps/cms
   RUN pnpm install --frozen-lockfile
   RUN cd apps/cms && pnpm run build
   ```

5. **Acronym & Brand Protection**:
   For brand names (e.g. `iClima`, `IT-PYX`) or technical abbreviations (`HVAC`, `BTU`, `SEER`), add them to `customValueExclusions` if you want them left untranslated.
