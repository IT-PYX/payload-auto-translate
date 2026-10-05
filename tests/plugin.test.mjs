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
  await t.test('supports customValuePatterns (RegExp and strings) for hardware specs & tokens', () => {
    const patterns = [/^IP[0-9]{2}$/i, /^RS-?485$/i, /^SUS\s*(304|316)$/i, '^DC\\s*\\d+V?$'];
    assert.equal(shouldSkipValue('IP65', undefined, patterns), true);
    assert.equal(shouldSkipValue('IP68', undefined, patterns), true);
    assert.equal(shouldSkipValue('RS485', undefined, patterns), true);
    assert.equal(shouldSkipValue('RS-485', undefined, patterns), true);
    assert.equal(shouldSkipValue('SUS304', undefined, patterns), true);
    assert.equal(shouldSkipValue('SUS 316', undefined, patterns), true);
    assert.equal(shouldSkipValue('DC 24V', undefined, patterns), true);
    assert.equal(shouldSkipValue('Standard Turnstile Door', undefined, patterns), false);
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
    assert.equal(defaultSlugify('مكيف الهواء الذکی', 'ar', { latinLocalesOnly: true }), '');
    assert.equal(defaultSlugify('インバーターエアコン', 'ja', { latinLocalesOnly: true }), '');
    assert.equal(defaultSlugify('Кондиционеры инверторные', 'ru', { latinLocalesOnly: true }), '');
  });

  await t.test('supports native Unicode slugs when latinLocalesOnly: false', () => {
    // Russian with short-i (й) preservation (NFC composed)
    const ruSlug = defaultSlugify('Инверторный сплит-кондиционер', 'ru', { latinLocalesOnly: false });
    assert.equal(ruSlug, 'инверторный-сплит-кондиционер');

    // Arabic with hamza preservation (NFC composed)
    const arSlug = defaultSlugify(
      'كيف يؤدي التوريد المباشر للمصنع إلى تعطيل التوزيع التقليدي لأنظمة التدفئة والتهوية وتكييف الهواء',
      'ar',
      { latinLocalesOnly: false, maxLength: 120 },
    );
    assert.equal(
      arSlug,
      'كيف-يؤدي-التوريد-المباشر-للمصنع-إلى-تعطيل-التوزيع-التقليدي-لأنظمة-التدفئة-والتهوية-وتكييف-الهواء',
    );

    // Japanese Kanji & Katakana
    const jaSlug = defaultSlugify('品質', 'ja', { latinLocalesOnly: false });
    assert.equal(jaSlug, '品質');
  });

  await t.test('clamps long slugs safely at word/hyphen boundary without splitting Unicode characters', () => {
    const longTitle = 'This is a very long title that exceeds ninety characters by quite a bit and should be trimmed safely at hyphen';
    const slug = defaultSlugify(longTitle, 'en', { maxLength: 50 });
    assert.ok(slug.length <= 50);
    assert.ok(!slug.endsWith('-'));

    const longJa = '品質管理と製造工程の徹底的な検査および国際認証基準の遵守に関する詳細な分析レポート';
    const jaClamped = defaultSlugify(longJa, 'ja', { latinLocalesOnly: false, maxLength: 20 });
    assert.ok(Array.from(jaClamped).length <= 20);
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

  await t.test('strips multiple chained suffixes if encountered from legacy data', () => {
    const chainedItem = {
      id: 'block_hero_1_es_fr_ar_pt_de_ru_ja',
      blockType: 'hero',
      items: [
        { id: 'item_a_es_fr_ar', label: 'Item A' },
      ],
    };
    localizeItemIds(chainedItem, 'ja');
    assert.equal(chainedItem.id, 'block_hero_1_ja');
    assert.equal(chainedItem.items[0].id, 'item_a_ja');
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

test('5. Document Extraction & Application with Custom Patterns', async (t) => {
  await t.test('extractTranslatableStrings respects customValuePatterns', () => {
    const doc = {
      title: 'Flap Barrier Turnstile',
      rating: 'IP65',
      protocol: 'RS485',
      material: 'SUS304',
      description: 'High speed gate with robust construction',
    };
    const patterns = [/^IP\d+$/i, /^RS-?485$/i, /^SUS\s*(304|316)$/i];
    const strings = extractTranslatableStrings(doc, new Set(), new Set(), false, undefined, patterns);

    assert.ok(strings.has('Flap Barrier Turnstile'));
    assert.ok(strings.has('High speed gate with robust construction'));
    assert.ok(!strings.has('IP65'));
    assert.ok(!strings.has('RS485'));
    assert.ok(!strings.has('SUS304'));
  });

  await t.test('mergePreservingExisting handles existing blocks with chained suffixes', () => {
    const translated = {
      sections: [
        { id: 'hero_1', blockType: 'hero', title: 'Japanese Hero' },
      ],
    };
    const existing = {
      sections: [
        { id: 'hero_1_es_fr_ar_ja', blockType: 'hero', title: 'Existing Japanese Hero' },
      ],
    };
    const merged = mergePreservingExisting(translated, existing);
    assert.equal(merged.sections.length, 1);
    assert.equal(merged.sections[0].title, 'Existing Japanese Hero');
  });
});
