import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
    external: ['payload', 'pg', 'dotenv'],
  },
  {
    entry: {
      'crawler/database-crawler': 'src/crawler/database-crawler.ts',
      'crawler/run-bulk': 'src/crawler/run-bulk.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: false,
    external: ['payload', 'pg', 'dotenv'],
  },
])
