import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractTranslatableSchemaStrings,
  applySchemaTranslations,
  localizeSchemaUrl,
} from '../dist/index.js'

describe('Schema.org JSON-LD Translator & Localizer', () => {
  const sampleGraphSchema = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': 'https://www.iclimaair.com/#organization',
        name: 'iClima',
        url: 'https://www.iclimaair.com/',
        slogan: 'Air Conditioner Manufacturer in China for Distributors & Importers',
        areaServed: 'Worldwide',
        description: 'Direct air conditioner factory in China.',
        knowsAbout: ['Inverter split air conditioners', 'R32 refrigerant'],
        contactPoint: [
          {
            '@type': 'ContactPoint',
            url: 'https://www.iclimaair.com/contact',
            areaServed: 'Worldwide',
            contactType: 'sales',
          },
        ],
        logo: {
          '@type': 'ImageObject',
          '@id': 'https://www.iclimaair.com/#logo',
          url: 'https://www.iclimaair.com/images/logo.svg',
        },
      },
      {
        '@type': 'WebSite',
        '@id': 'https://www.iclimaair.com/#website',
        url: 'https://www.iclimaair.com/',
        name: 'iClimaAir',
        publisher: { '@id': 'https://www.iclimaair.com/#organization' },
        inLanguage: 'en',
      },
      {
        '@type': ['WebPage', 'FAQPage'],
        '@id': 'https://www.iclimaair.com/#webpage',
        url: 'https://www.iclimaair.com/',
        name: 'China Air Conditioner Manufacturer & Supplier | iClimaAir',
        description: 'Direct factory air conditioners for distributors.',
        isPartOf: { '@id': 'https://www.iclimaair.com/#website' },
        inLanguage: 'en',
        mainEntity: [
          {
            '@type': 'Question',
            name: 'Is iClimaAir a factory or trading company?',
            acceptedAnswer: {
              '@type': 'Answer',
              text: 'iClimaAir is a direct factory manufacturer in Shunde, China.',
            },
          },
        ],
      },
      {
        '@type': 'Product',
        '@id': 'https://www.iclimaair.com/inverter-split-ac#product',
        url: 'https://www.iclimaair.com/inverter-split-ac',
        name: 'Inverter Split Air Conditioner',
        description: '9,000-24,000 BTU wall mounted R32 unit.',
        brand: {
          '@type': 'Brand',
          name: 'iClima',
        },
        offers: {
          '@type': 'Offer',
          availability: 'https://schema.org/InStock',
        },
      },
    ],
  }

  test('extractTranslatableSchemaStrings extracts text fields but skips types, enums, and brand names', () => {
    const strings = extractTranslatableSchemaStrings(sampleGraphSchema)

    // Should include Product name, WebPage name/description, FAQ question name & answer text
    assert.ok(strings.has('China Air Conditioner Manufacturer & Supplier | iClimaAir'))
    assert.ok(strings.has('Direct factory air conditioners for distributors.'))
    assert.ok(strings.has('Is iClimaAir a factory or trading company?'))
    assert.ok(strings.has('iClimaAir is a direct factory manufacturer in Shunde, China.'))
    assert.ok(strings.has('Inverter Split Air Conditioner'))
    assert.ok(strings.has('9,000-24,000 BTU wall mounted R32 unit.'))

    // Should include Organization slogan, areaServed, description, and knowsAbout items
    assert.ok(strings.has('Air Conditioner Manufacturer in China for Distributors & Importers'))
    assert.ok(strings.has('Worldwide'))
    assert.ok(strings.has('Direct air conditioner factory in China.'))
    assert.ok(strings.has('Inverter split air conditioners'))
    assert.ok(strings.has('R32 refrigerant'))

    // Should NOT include Organization name or Brand name
    assert.ok(!strings.has('iClima'))

    // Should NOT include types or context
    assert.ok(!strings.has('Organization'))
    assert.ok(!strings.has('WebPage'))
    assert.ok(!strings.has('Product'))
    assert.ok(!strings.has('https://schema.org'))
    assert.ok(!strings.has('https://schema.org/InStock'))
  })

  test('localizeSchemaUrl preserves global singletons, static assets, and localizes root and inner pages', () => {
    const siteUrl = 'https://www.iclimaair.com'

    // Global singletons must remain intact across all languages
    assert.equal(
      localizeSchemaUrl('https://www.iclimaair.com/#organization', 'es', siteUrl),
      'https://www.iclimaair.com/#organization',
    )
    assert.equal(
      localizeSchemaUrl('https://www.iclimaair.com/#website', 'es', siteUrl),
      'https://www.iclimaair.com/#website',
    )
    assert.equal(
      localizeSchemaUrl('https://www.iclimaair.com/#logo', 'es', siteUrl),
      'https://www.iclimaair.com/#logo',
    )

    // Static assets must not be localized
    assert.equal(
      localizeSchemaUrl('https://www.iclimaair.com/images/logo.svg', 'es', siteUrl),
      'https://www.iclimaair.com/images/logo.svg',
    )

    // Root homepage URL localizes to /es (no trailing slash)
    assert.equal(
      localizeSchemaUrl('https://www.iclimaair.com/', 'es', siteUrl),
      'https://www.iclimaair.com/es',
    )

    // Document nodes localize
    assert.equal(
      localizeSchemaUrl('https://www.iclimaair.com/#webpage', 'es', siteUrl),
      'https://www.iclimaair.com/es#webpage',
    )
    assert.equal(
      localizeSchemaUrl('https://www.iclimaair.com/inverter-split-ac', 'es', siteUrl),
      'https://www.iclimaair.com/es/inverter-split-ac',
    )

    // Custom localizer callback is respected
    const customLocalizer = (path, lang) => {
      if (path === '/inverter-split-ac') return `/${lang}/aire-acondicionado-split-inverter`
      return `/${lang}${path}`
    }
    assert.equal(
      localizeSchemaUrl('https://www.iclimaair.com/inverter-split-ac', 'es', siteUrl, customLocalizer),
      'https://www.iclimaair.com/es/aire-acondicionado-split-inverter',
    )
  })

  test('applySchemaTranslations updates text, inLanguage, and URLs seamlessly', () => {
    const siteUrl = 'https://www.iclimaair.com'
    const translationMap = new Map([
      ['China Air Conditioner Manufacturer & Supplier | iClimaAir', 'Fabricante de aire acondicionado | iClimaAir'],
      ['Direct factory air conditioners for distributors.', 'Aires acondicionados directos de fábrica.'],
      ['Is iClimaAir a factory or trading company?', '¿Es iClimaAir una fábrica o una empresa comercial?'],
      ['iClimaAir is a direct factory manufacturer in Shunde, China.', 'iClimaAir es un fabricante directo en Shunde, China.'],
      ['Inverter Split Air Conditioner', 'Aire acondicionado split inverter'],
      ['9,000-24,000 BTU wall mounted R32 unit.', 'Unidad R32 de 9.000 a 24.000 BTU.'],
      ['Air Conditioner Manufacturer in China for Distributors & Importers', 'Fabricante de aire acondicionado en China para distribuidores e importadores'],
      ['Worldwide', 'Mundial'],
      ['Direct air conditioner factory in China.', 'Fábrica directa de aire acondicionado en China.'],
      ['Inverter split air conditioners', 'Acondicionadores de aire split inverter'],
      ['R32 refrigerant', 'Refrigerante R32'],
    ])

    const localized = applySchemaTranslations(sampleGraphSchema, translationMap, 'es', { siteUrl })

    // Valid graph structure
    assert.equal(localized['@context'], 'https://schema.org')
    assert.equal(localized['@graph'].length, 4)

    const org = localized['@graph'][0]
    assert.equal(org.name, 'iClima') // Brand name preserved
    assert.equal(org['@id'], 'https://www.iclimaair.com/#organization') // Global singleton preserved
    assert.equal(org.slogan, 'Fabricante de aire acondicionado en China para distribuidores e importadores')
    assert.equal(org.areaServed, 'Mundial')
    assert.equal(org.description, 'Fábrica directa de aire acondicionado en China.')
    assert.equal(org.knowsAbout[0], 'Acondicionadores de aire split inverter')
    assert.equal(org.knowsAbout[1], 'Refrigerante R32')
    assert.equal(org.contactPoint[0].url, 'https://www.iclimaair.com/es/contact')
    assert.equal(org.contactPoint[0].areaServed, 'Mundial')

    const webPage = localized['@graph'][2]
    assert.equal(webPage.inLanguage, 'es')
    assert.equal(webPage.name, 'Fabricante de aire acondicionado | iClimaAir')
    assert.equal(webPage.url, 'https://www.iclimaair.com/es')
    assert.equal(webPage['@id'], 'https://www.iclimaair.com/es#webpage')
    assert.equal(webPage.mainEntity[0].name, '¿Es iClimaAir una fábrica o una empresa comercial?')
    assert.equal(webPage.mainEntity[0].acceptedAnswer.text, 'iClimaAir es un fabricante directo en Shunde, China.')

    const prod = localized['@graph'][3]
    assert.equal(prod.name, 'Aire acondicionado split inverter')
    assert.equal(prod.url, 'https://www.iclimaair.com/es/inverter-split-ac')
    assert.equal(prod.brand.name, 'iClima')
    assert.equal(prod.offers.availability, 'https://schema.org/InStock') // Enum preserved
  })
})
