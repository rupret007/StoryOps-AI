import { createExteriorServicesConfiguration } from '@/domain/companyConfiguration';
import { createExteriorConfigurationPricing } from '@/data/exteriorServiceTemplates';

export function customPublishedPricingConfiguration() {
  const enabledServiceCodes = ['pressure-wash-flatwork', 'gutter-cleaning'] as const;
  const configuration = createExteriorServicesConfiguration({
    legalName: 'Story Exterior Care',
    ownerName: 'Jeff Story',
    publicEmail: 'owner@example.test',
    publicPhone: '+18175550100',
    addressLine1: '100 Sandbox Service Road',
    city: 'Grapevine',
    postalCode: '76051',
    enabledServiceCodes: [...enabledServiceCodes],
    ...createExteriorConfigurationPricing(enabledServiceCodes),
  });
  configuration.pricing.companyMinimum = '333.00';
  configuration.pricing.marginFloorPercent = '55.00';
  configuration.pricing.automaticDiscountLimitPercent = '7.50';
  configuration.pricing.defaultTaxRatePercent = '6.5000';
  configuration.payments.depositValue = '40.00';
  const flatwork = configuration.pricing.serviceRules.find(
    (rule) => rule.serviceCode === 'pressure-wash-flatwork',
  )!;
  flatwork.basePrice = '987.65';
  flatwork.unitPrice = '0.330000';
  configuration.territory.travelZones = [
    {
      code: 'OWNER-ZONE',
      name: 'Owner custom zone',
      maximumMiles: '12.5',
      fee: '48.25',
      postalCodes: ['76051'],
    },
  ];
  return configuration;
}
