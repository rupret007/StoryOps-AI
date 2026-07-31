import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { calculateDemoPrice, summarizeDemoServiceTotals } from '@/data/priceBook';
import {
  createExteriorConfigurationPricing,
  type ExteriorServiceCode,
} from '@/data/exteriorServiceTemplates';
import { createExteriorServicesConfiguration } from '@/domain/companyConfiguration';
import { createDemoState } from '@/state/demoSeed';

describe('sandbox deterministic quote snapshot', () => {
  it('seeds aggregate and customer line-item amounts from the same price-book calculation', () => {
    const estimate = createDemoState().estimate;
    const result = calculateDemoPrice(estimate);
    const services = summarizeDemoServiceTotals(result);

    expect(estimate.serviceSubtotal).toBe(result.serviceSubtotal.amount);
    expect(estimate.tax).toBe(result.tax.amount);
    expect(estimate.total).toBe(result.total.amount);
    expect(estimate.deposit).toBe(result.depositRequired.amount);
    expect(estimate.estimatedCost).toBe(result.estimatedCost.amount);
    expect(estimate.durationMinutes).toBe(result.durationMinutes);
    expect(services).toEqual({ driveway: '215.00', gutters: '352.36' });
    expect(new Decimal(services.driveway).plus(services.gutters).toFixed(2)).toBe(
      estimate.serviceSubtotal,
    );
    expect(estimate.total).toBe('614.17');
  });

  it('uses the exact published sandbox pricing snapshot instead of the seed price book', () => {
    const enabledServiceCodes = [
      'pressure-wash-flatwork',
      'gutter-cleaning',
    ] satisfies ExteriorServiceCode[];
    const configuration = createExteriorServicesConfiguration({
      legalName: 'Story Exterior Care',
      ownerName: 'Jeff Story',
      publicEmail: 'owner@example.test',
      publicPhone: '+18175550100',
      addressLine1: '100 Sandbox Service Road',
      city: 'Grapevine',
      postalCode: '76051',
      enabledServiceCodes,
      ...createExteriorConfigurationPricing(enabledServiceCodes),
    });
    const flatworkRule = configuration.pricing.serviceRules.find(
      (rule) => rule.serviceCode === 'pressure-wash-flatwork',
    )!;
    flatworkRule.unitPrice = '0.50';

    const seedResult = calculateDemoPrice(createDemoState().estimate);
    const configuredResult = calculateDemoPrice(createDemoState().estimate, configuration);

    expect(configuredResult.priceBookVersion).toBe(configuration.pricing.priceBookTemplateVersion);
    expect(new Decimal(configuredResult.total.amount).greaterThan(seedResult.total.amount)).toBe(
      true,
    );
  });
});
