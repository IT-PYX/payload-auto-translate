import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergePreservingExisting,
  extractTranslatableStrings,
  applyTranslationsToDocument,
  isTranslatableField,
  shouldSkipValue,
  defaultSlugify,
  localizeItemIds,
} from '../dist/index.js';

test('1. Array & Block Merging (mergePreservingExisting)', async (t) => {
  await t.test('updates empty fields in existing block while preserving existing human translations', () => {
    const translated = {
      title: 'Título Traducido',
      subtitle: 'Subtítulo Traducido',
      sections: [
        {
          id: 'b1',
          blockType: 'hero',
          headline: 'Titular Traducido',
          subtext: 'Texto Traducido',
        },
      ],
    };
    const existing = {
      title: 'Título Personalizado por Humano', // Should be preserved!
      subtitle: '', // Empty, should take translated!
      sections: [
        {
          id: 'b1_es',
          blockType: 'hero',
          headline: 'Titular Manual', // Preserved!
          subtext: '', // Empty, should take translated!
        },
      ],
    };

    const merged = mergePreservingExisting(translated, existing);
    assert.equal(merged.title, 'Título Personalizado por Humano');
    assert.equal(merged.subtitle, 'Subtítulo Traducido');
    assert.equal(merged.sections.length, 1);
    assert.equal(merged.sections[0].headline, 'Titular Manual');
    assert.equal(merged.sections[0].subtext, 'Texto Traducido');
  });

  await t.test('appends newly added source blocks to target locale array', () => {
    const translated = {
      sections: [
        { id: 'b1', blockType: 'hero', title: 'Hero' },
        { id: 'b2', blockType: 'cta', title: 'Nuevo CTA' },
      ],
    };
    const existing = {
      sections: [
        { id: 'b1_es', blockType: 'hero', title: 'Hero Existente' },
      ],
    };

    const merged = mergePreservingExisting(translated, existing);
    assert.equal(merged.sections.length, 2);
    assert.equal(merged.sections[0].title, 'Hero Existente');
    assert.equal(merged.sections[1].title, 'Nuevo CTA');
    assert.equal(merged.sections[1].blockType, 'cta');
  });

  await t.test('handles block reordering safely without mashing disparate blockTypes', () => {
    // Source page in English was reordered: CTA first, Hero second
    const translated = {
      sections: [
        { id: 'b2', blockType: 'cta', buttonText: 'Contactar' },
        { id: 'b1', blockType: 'hero', heading: 'Bienvenido' },
      ],
    };
    // Target locale had: Hero first, CTA second
    const existing = {
      sections: [
        { id: 'b1_es', blockType: 'hero', heading: 'Bienvenido Manual' },
        { id: 'b2_es', blockType: 'cta', buttonText: 'Contactar Manual' },
      ],
    };

    const merged = mergePreservingExisting(translated, existing);
    assert.equal(merged.sections.length, 2);
    // Order follows the source layout
    assert.equal(merged.sections[0].blockType, 'cta');
    assert.equal(merged.sections[0].buttonText, 'Contactar Manual');
    assert.equal(merged.sections[1].blockType, 'hero');
    assert.equal(merged.sections[1].heading, 'Bienvenido Manual');
  });
});

test('2. Filter & Exclusions (filter.ts)', async (t) => {
  await t.test('excludes system fields and generic link/URL suffixes across any project', () => {
    assert.equal(isTranslatableField('id'), false);
    assert.equal(isTranslatableField('blockType'), false);
    assert.equal(isTranslatableField('createdAt'), false);
    assert.equal(isTranslatableField('buttonHref'), false);
    assert.equal(isTranslatableField('cta_href'), false);
    assert.equal(isTranslatableField('targetUrl'), false);
    assert.equal(isTranslatableField('customLink'), false);
    assert.equal(isTranslatableField('proposalLinkHref'), false);
  });

  await t.test('handles slug translation toggle', () => {
    assert.equal(isTranslatableField('slug', undefined, false), false);
    assert.equal(isTranslatableField('slug', undefined, true), true);
  });

  await t.test('supports customFieldExclusions', () => {
    const custom = new Set(['skuNumber', 'internalNote']);
    assert.equal(isTranslatableField('skuNumber', custom), false);
    assert.equal(isTranslatableField('internalNote', custom), false);
    assert.equal(isTranslatableField('title', custom), true);
  });

  await t.test('skips URLs and technical enum tokens but allows content words', () => {
    // Technical tokens to skip
    assert.equal(shouldSkipValue('https://example.com'), true);
    assert.equal(shouldSkipValue('/api/preview'), true);
    assert.equal(shouldSkipValue('mailto:test@example.com'), true);
    assert.equal(shouldSkipValue('centered'), true);
    assert.equal(shouldSkipValue('contain'), true);
    assert.equal(shouldSkipValue('solid'), true);

    // Legitimate content words that were previously blocked must now be translatable!
    assert.equal(shouldSkipValue('Hero'), false);
    assert.equal(shouldSkipValue('Warning: High Voltage'), false);
    assert.equal(shouldSkipValue('Info'), false);
    assert.equal(shouldSkipValue('Success Stories'), false);
    assert.equal(shouldSkipValue('Section 1'), false);
  });

  await t.test('supports customValueExclusions', () => {
    const customVals = new Set(['ACME_CORP', 'PROJECT_OMEGA']);
    assert.equal(shouldSkipValue('ACME_CORP', customVals), true);
    assert.equal(shouldSkipValue('Normal Text', customVals), false);
  });
});

test('3. SEO Slugifier (slugifier.ts)', async (t) => {
  await t.test('expands German umlauts and eszett', () => {
    const slug = defaultSlugify('Lüftungstechnik Köln & Düsseldorf Grüße', 'de');
    assert.equal(slug, 'lueftungstechnik-koeln-duesseldorf-gruesse');
  });

  await t.test('decomposes French and Spanish accents and trims non-alphanumerics', () => {
    const frSlug = defaultSlugify('Climatisation Écologique & Énergétique (2026)', 'fr');
    assert.equal(frSlug, 'climatisation-ecologique-energetique-2026');

    const esSlug = defaultSlugify('¿Cómo elegir el mejor aire acondicionado?', 'es');
    assert.equal(esSlug, 'como-elegir-el-mejor-aire-acondicionado');
  });

  await t.test('safely falls back for non-Latin locales when latinLocalesOnly: true', () => {
    assert.equal(defaultSlugify('مكيف الهواء الذكي', 'ar', { latinLocalesOnly: true }), '');
    assert.equal(defaultSlugify('インバーターエアコン', 'ja', { latinLocalesOnly: true }), '');
    assert.equal(defaultSlugify('Кондиционеры инверторные', 'ru', { latinLocalesOnly: true }), '');
  });

  await t.test('supports native Unicode slugs when latinLocalesOnly: false', () => {
    const ruSlug = defaultSlugify('Кондиционеры инверторные', 'ru', { latinLocalesOnly: false });
    assert.equal(ruSlug, 'кондиционеры-инверторные');

    const arSlug = defaultSlugify('مكيف الهواء الذكي', 'ar', { latinLocalesOnly: false });
    assert.equal(arSlug, 'مكيف-الهواء-الذكي');
  });

  await t.test('clamps long slugs at word/hyphen boundary', () => {
    const longTitle = 'This is a very long title that exceeds ninety characters by quite a bit and should be trimmed safely at hyphen';
    const slug = defaultSlugify(longTitle, 'en', { maxLength: 50 });
    assert.ok(slug.length <= 50);
    assert.ok(!slug.endsWith('-'));
  });
});

test('4. Block ID Localizer & Database Safety (localizeItemIds)', async (t) => {
  await t.test('appends locale suffix to string IDs idempotently', () => {
    const item = {
      id: 'block_hero_1',
      blockType: 'hero',
      items: [
        { id: 'item_a', label: 'Item A' },
      ],
    };
    localizeItemIds(item, 'es');
    assert.equal(item.id, 'block_hero_1_es');
    assert.equal(item.items[0].id, 'item_a_es');

    // Run again to verify idempotency (no _es_es chaining)
    localizeItemIds(item, 'es');
    assert.equal(item.id, 'block_hero_1_es');
    assert.equal(item.items[0].id, 'item_a_es');
  });

  await t.test('deletes numeric/serial IDs so database autoincrement sequence takes over', () => {
    const item = {
      id: 105, // Numeric serial primary key in PostgreSQL table
      title: 'Slide Title',
      slides: [
        { id: 201, image: 'pic.jpg' },
      ],
    };
    localizeItemIds(item, 'es');
    assert.equal(item.id, undefined);
    assert.equal(item.slides[0].id, undefined);
  });
});
