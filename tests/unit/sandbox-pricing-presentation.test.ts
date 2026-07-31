import { describe, expect, it } from 'vitest';
import { deriveSandboxPricingPresentation } from '@/data/sandboxPricingPresentation';
import { customPublishedPricingConfiguration } from '../fixtures/customPublishedPricing';

describe('sandbox pricing presentation', () => {
  it('projects exact published values and labels the unconfigured fallback as a fixture', () => {
    const published = deriveSandboxPricingPresentation(customPublishedPricingConfiguration());

    expect(published).toMatchObject({
      source: 'published_configuration',
      companyMinimum: '$333.00',
      marginFloor: '55%',
      automaticDiscountLimit: '7.5%',
      deposit: '40%',
      taxRule: '6.5%',
    });
    expect(
      published.serviceRules.find((rule) => rule.serviceCode === 'pressure-wash-flatwork')?.summary,
    ).toContain('$987.65 base · $0.33 / sq ft');
    expect(published.travelZones).toEqual([
      {
        code: 'OWNER-ZONE',
        name: 'Owner custom zone',
        boundary: 'Up to 12.5 one-way miles',
        fee: '$48.25',
      },
    ]);

    const fallback = deriveSandboxPricingPresentation();
    expect(fallback.source).toBe('starter_fixture');
    expect(fallback.sourceLabel).toMatch(/fixture only.*no company configuration published/iu);
  });
});
