import {
  asDecimalString,
  asDomainId,
  asISODateTime,
  validateServiceIndustryPack,
  type PriceBook,
} from '@/domain';
import {
  calculateEstimate,
  calculatePackageEstimate,
  type PackagePricingRequest,
  type PricingRequest,
  type RequestedService,
} from '@/core/pricing';
import {
  createExteriorConfigurationPackages,
  createExteriorStarterPriceBook,
  EXTERIOR_ADD_ON_CODES,
  EXTERIOR_PACKAGE_IDENTITIES,
  EXTERIOR_PACKAGE_CODES,
  EXTERIOR_SERVICE_CODES,
  exteriorServicesIndustryPack,
  exteriorServicePackages,
  exteriorServiceTemplates,
  getExteriorServicePackage,
} from '@/data/exteriorServiceTemplates';
import {
  createResidentialConfigurationPackages,
  createResidentialStarterPriceBook,
  residentialCleaningIndustryPack,
  residentialPackages,
} from '@/data/residentialServiceTemplates';
import { getServiceIndustryPack, serviceIndustryPacks } from '@/data/industryPacks';

const companyId = asDomainId('20000000-0000-4000-8000-000000000001');
const priceBookId = asDomainId('20000000-0000-4000-8000-000000000401');
const propertyId = asDomainId('20000000-0000-4000-8000-000000000211');
const measurementId = asDomainId('20000000-0000-4000-8000-000000000441');
const publisherId = asDomainId('20000000-0000-4000-8000-000000000101');
const calculatedAt = asISODateTime('2026-07-28T12:00:00.000-05:00');

const buildPriceBook = (): PriceBook =>
  createExteriorStarterPriceBook({
    id: priceBookId,
    companyId,
    createdAt: asISODateTime('2026-07-01T00:00:00.000-05:00'),
    updatedAt: asISODateTime('2026-07-01T00:00:00.000-05:00'),
    version: 3,
    status: 'active',
    effectiveFrom: asISODateTime('2026-07-01T00:00:00.000-05:00'),
    publishedBy: publisherId,
    publishedAt: asISODateTime('2026-07-01T00:00:00.000-05:00'),
  });

const driveway = (): RequestedService => ({
  serviceCode: 'pressure-wash-flatwork',
  quantity: asDecimalString('1250'),
  attributes: {
    surface: 'concrete',
    soil: 'moderate',
    access: 'clear',
    risk: 'standard',
  },
  addOns: [],
  sourceMeasurementIds: [measurementId],
});

const house = (): RequestedService => ({
  serviceCode: 'soft-wash-house',
  quantity: asDecimalString('2000'),
  attributes: {
    stories: '1',
    siding_material: 'vinyl',
    organic_growth: 'moderate',
    access: 'clear',
    risk: 'standard',
  },
  addOns: [],
  sourceMeasurementIds: [measurementId],
});

const gutters = (): RequestedService => ({
  serviceCode: 'gutter-cleaning',
  quantity: asDecimalString('188'),
  attributes: {
    stories: '2',
    gutter_guards: 'none',
    roof_access: 'clear',
    debris: 'moderate',
    risk: 'standard',
  },
  addOns: [{ code: 'DOWNSPOUT_FLUSH', quantity: asDecimalString('4') }],
  sourceMeasurementIds: [measurementId],
});

const roof = (): RequestedService => ({
  serviceCode: 'roof-washing',
  quantity: asDecimalString('1800'),
  attributes: {
    stories: '1',
    roof_pitch: 'walkable',
    roof_material: 'asphalt',
    roof_access: 'clear',
    organic_growth: 'moderate',
    risk: 'standard',
  },
  addOns: [],
  sourceMeasurementIds: [measurementId],
});

const windows = (): RequestedService => ({
  serviceCode: 'window-cleaning',
  quantity: asDecimalString('24'),
  attributes: {
    stories: '1',
    service_side: 'exterior',
    screens: 'excluded',
    tracks: 'excluded',
    access: 'clear',
    risk: 'standard',
  },
  addOns: [],
  sourceMeasurementIds: [measurementId],
});

const pricingRequest = (service: RequestedService): PricingRequest => ({
  requestId: `registry:${service.serviceCode}`,
  companyId,
  propertyId,
  priceBook: buildPriceBook(),
  services: [service],
  discount: { kind: 'none' },
  customerTaxExempt: false,
  scopeEvidenceDisposition: 'usable_for_scope',
  calculatedAt,
});

const packageRequest = (
  packageCode: 'ESSENTIAL_CARE' | 'CURB_APPEAL_PLUS' | 'WHOLE_PROPERTY_CARE',
  measuredServices: readonly RequestedService[],
  selectedOptionalServiceCodes: readonly string[] = [],
  enabledServiceCodes: readonly (typeof EXTERIOR_SERVICE_CODES)[number][] = EXTERIOR_SERVICE_CODES,
  selectedOptionalAddOns: readonly {
    serviceCode: string;
    addOnCode: string;
  }[] = [],
): PackagePricingRequest => ({
  requestId: `package:${packageCode}`,
  companyId,
  propertyId,
  priceBook: buildPriceBook(),
  packageDefinition: getExteriorServicePackage(packageCode, enabledServiceCodes),
  measuredServices,
  selectedOptionalServiceCodes,
  selectedOptionalAddOns,
  discount: { kind: 'none' },
  customerTaxExempt: false,
  scopeEvidenceDisposition: 'usable_for_scope',
  calculatedAt,
});

describe('exterior service starter registry', () => {
  it('registers exterior and residential services as valid, replaceable industry packs', () => {
    expect(serviceIndustryPacks.map((pack) => pack.code)).toEqual([
      'exterior-services',
      'residential-cleaning',
    ]);
    expect(getServiceIndustryPack('exterior-services')).toBe(exteriorServicesIndustryPack);
    expect(getServiceIndustryPack('residential-cleaning')).toBe(residentialCleaningIndustryPack);
    expect(validateServiceIndustryPack(exteriorServicesIndustryPack)).toEqual([]);
    expect(validateServiceIndustryPack(residentialCleaningIndustryPack)).toEqual([]);
    expect(exteriorServicesIndustryPack.supportedKernelCapabilities).toContain('ai_office');
  });

  it('keeps a deterministic residential starter registry', () => {
    const priceBook = createResidentialStarterPriceBook({
      id: asDomainId('20000000-0000-4000-8000-000000000002'),
      companyId,
      createdAt: asISODateTime('2026-07-01T00:00:00.000-05:00'),
      updatedAt: asISODateTime('2026-07-01T00:00:00.000-05:00'),
      version: 3,
      status: 'active',
      effectiveFrom: asISODateTime('2026-07-01T00:00:00.000-05:00'),
      publishedBy: companyId,
      publishedAt: asISODateTime('2026-07-01T00:00:00.000-05:00'),
    });

    expect(residentialPackages.map((definition) => definition.code)).toHaveLength(3);
    expect(createResidentialConfigurationPackages()).toEqual(residentialPackages);
    expect(priceBook.serviceRules.map((rule) => rule.serviceCode).length).toBe(3);
    expect(
      priceBook.serviceRules
        .map((rule) => rule.serviceCode)
        .every(
          (code) => code.startsWith('standard') || code.startsWith('deep') || code.includes('move'),
        ),
    ).toBe(true);
  });

  it('keeps the kernel open to bounded non-exterior categories and pricing dimensions', () => {
    const source = exteriorServiceTemplates[0]!;
    const alternatePack = {
      code: 'landscape-maintenance',
      name: 'Landscape maintenance',
      version: 'landscape-v1',
      description: 'Contract fixture proving that the kernel vocabulary is pack-owned.',
      serviceCodes: ['lawn-mowing'],
      serviceTemplates: [
        {
          ...source,
          templateVersion: 'landscape-v1',
          catalogItem: {
            ...source.catalogItem,
            code: 'lawn-mowing',
            category: 'landscape_maintenance',
            requiredMeasurementKinds: ['area_sq_ft'] as const,
          },
          scope: {
            ...source.scope,
            primaryMeasurementKind: 'lawn_area_sq_ft',
            scopeEvidencePolicy: 'not_applicable' as const,
            requiredPhotoViews: [],
          },
          priceRule: {
            ...source.priceRule,
            serviceCode: 'lawn-mowing',
            allowedAttributeValues: { turf_condition: ['maintained'] },
            attributeMultipliers: [
              {
                attribute: 'turf_condition',
                value: 'maintained',
                multiplier: asDecimalString('1'),
              },
            ],
          },
        },
      ],
      supportedKernelCapabilities: exteriorServicesIndustryPack.supportedKernelCapabilities,
    };

    expect(validateServiceIndustryPack(alternatePack)).toEqual([]);
    const nonPhotoResult = calculateEstimate({
      ...pricingRequest(driveway()),
      scopeEvidenceDisposition: 'not_applicable',
    });
    expect(nonPhotoResult.quoteable).toBe(true);
    expect(nonPhotoResult.approvalFlags).not.toContainEqual(
      expect.objectContaining({ reason: 'uncertain_scope' }),
    );

    const incompatiblePack = {
      ...alternatePack,
      serviceTemplates: [
        {
          ...alternatePack.serviceTemplates[0]!,
          catalogItem: {
            ...alternatePack.serviceTemplates[0]!.catalogItem,
            requiredMeasurementKinds: ['length_linear_ft'] as const,
          },
        },
      ],
    };
    expect(validateServiceIndustryPack(incompatiblePack)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SCOPE_MEASUREMENT_KIND_MISMATCH' }),
      ]),
    );
  });

  it('is the complete source for service rules, common add-ons, and good/better/best packages', () => {
    const priceBook = buildPriceBook();
    expect(exteriorServiceTemplates.map((template) => template.catalogItem.code)).toEqual(
      EXTERIOR_SERVICE_CODES,
    );
    expect(priceBook.serviceRules.map((rule) => rule.serviceCode)).toEqual(EXTERIOR_SERVICE_CODES);

    const registeredAddOns = new Set(
      priceBook.serviceRules.flatMap((rule) => rule.addOns.map((addOn) => addOn.code)),
    );
    expect([...EXTERIOR_ADD_ON_CODES].every((code) => registeredAddOns.has(code))).toBe(true);

    expect(exteriorServicePackages.map((definition) => definition.code)).toEqual(
      EXTERIOR_PACKAGE_CODES,
    );
    expect(exteriorServicePackages.map((definition) => definition.tier)).toEqual([
      'good',
      'better',
      'best',
    ]);
    expect(exteriorServicePackages.map(({ code, name, tier }) => ({ code, name, tier }))).toEqual(
      EXTERIOR_PACKAGE_IDENTITIES,
    );
    expect(exteriorServicePackages).toEqual(
      createExteriorConfigurationPackages(EXTERIOR_SERVICE_CODES),
    );

    for (const rule of priceBook.serviceRules) {
      for (const [attribute, values] of Object.entries(rule.allowedAttributeValues)) {
        for (const value of values ?? []) {
          expect(
            rule.attributeMultipliers.filter(
              (multiplier) => multiplier.attribute === attribute && multiplier.value === value,
            ),
            `${rule.serviceCode} ${attribute}=${value}`,
          ).toHaveLength(1);
        }
      }
    }
  });

  it('creates isolated price-book rule objects from the registry', () => {
    const first = buildPriceBook();
    const second = buildPriceBook();
    const firstRule = first.serviceRules[0];
    const secondRule = second.serviceRules[0];
    if (!firstRule || !secondRule) throw new Error('Expected starter service rules.');

    firstRule.unitPrice = asDecimalString('99');

    expect(secondRule.unitPrice).toBe('0.14');
    expect(exteriorServiceTemplates[0]!.priceRule.unitPrice).toBe('0.14');
  });

  it('uses one canonical package source with distinct honest default scopes', () => {
    const configured = createExteriorConfigurationPackages([
      'pressure-wash-flatwork',
      'gutter-cleaning',
    ]);
    expect(configured.map((servicePackage) => servicePackage.tier)).toEqual([
      'good',
      'better',
      'best',
    ]);
    expect(configured[0]?.components).toEqual([
      expect.objectContaining({
        serviceCode: 'pressure-wash-flatwork',
        requiredAddOnCodes: [],
      }),
    ]);
    expect(configured[1]?.components).toEqual([
      expect.objectContaining({ serviceCode: 'pressure-wash-flatwork' }),
      expect.objectContaining({
        serviceCode: 'gutter-cleaning',
        required: true,
        requiredAddOnCodes: [],
        optionalAddOnCodes: expect.arrayContaining(['DOWNSPOUT_FLUSH']),
      }),
    ]);
    expect(configured[2]?.components).toEqual([
      expect.objectContaining({ serviceCode: 'pressure-wash-flatwork' }),
      expect.objectContaining({
        serviceCode: 'gutter-cleaning',
        requiredAddOnCodes: ['DOWNSPOUT_FLUSH'],
        optionalAddOnCodes: [],
      }),
    ]);
    expect(
      new Set(configured.map((servicePackage) => JSON.stringify(servicePackage.components))).size,
    ).toBe(3);
    for (const definition of configured) {
      expect(
        getExteriorServicePackage(definition.code as (typeof EXTERIOR_PACKAGE_CODES)[number], [
          'pressure-wash-flatwork',
          'gutter-cleaning',
        ]),
      ).toEqual(definition);
    }
    expect(() => createExteriorConfigurationPackages(['pressure-wash-flatwork'])).toThrow(
      /at least three exterior services/iu,
    );
    expect(() =>
      createExteriorConfigurationPackages(['pressure-wash-flatwork', 'soft-wash-house']),
    ).toThrow(/at least three exterior services|two services including gutter cleaning/iu);
  });

  it('gives every default tier a materially distinct minimum priced scope', () => {
    const gutterWithoutFlush = { ...gutters(), addOns: [] };
    const enabled = ['pressure-wash-flatwork', 'gutter-cleaning'] as const;
    const cases = [
      {
        code: 'ESSENTIAL_CARE' as const,
        services: [driveway()],
        pricedServiceCodes: ['pressure-wash-flatwork'],
        pricedAddOnCodes: [],
        total: '243.56',
      },
      {
        code: 'CURB_APPEAL_PLUS' as const,
        services: [driveway(), gutterWithoutFlush],
        pricedServiceCodes: ['pressure-wash-flatwork', 'gutter-cleaning'],
        pricedAddOnCodes: [],
        total: '536.23',
      },
      {
        code: 'WHOLE_PROPERTY_CARE' as const,
        services: [driveway(), gutters()],
        pricedServiceCodes: ['pressure-wash-flatwork', 'gutter-cleaning'],
        pricedAddOnCodes: ['DOWNSPOUT_FLUSH'],
        total: '614.17',
      },
    ];

    for (const testCase of cases) {
      const result = calculatePackageEstimate(
        packageRequest(testCase.code, testCase.services, [], enabled),
      );
      expect(result.quoteable, testCase.code).toBe(true);
      expect(result.pricedServiceCodes, testCase.code).toEqual(testCase.pricedServiceCodes);
      expect(
        result.lines.flatMap((line) => (line.addOnCode ? [line.addOnCode] : [])),
        testCase.code,
      ).toEqual(testCase.pricedAddOnCodes);
      expect(result.total.amount, testCase.code).toBe(testCase.total);
    }
    expect(new Set(cases.map((testCase) => testCase.total)).size).toBe(3);
  });

  it.each([
    {
      name: 'driveway/flatwork',
      service: driveway,
      subtotal: '215.00',
      minimum: '10.00',
      cost: '82.50',
      duration: 87,
    },
    {
      name: 'house soft wash',
      service: house,
      subtotal: '299.00',
      minimum: '0.00',
      cost: '98.00',
      duration: 118,
    },
    {
      name: 'gutter/downspout',
      service: gutters,
      subtotal: '352.36',
      minimum: '0.00',
      cost: '114.97',
      duration: 148,
    },
    {
      name: 'roof wash',
      service: roof,
      subtotal: '451.00',
      minimum: '0.00',
      cost: '204.00',
      duration: 198,
    },
    {
      name: 'window cleaning',
      service: windows,
      subtotal: '211.00',
      minimum: '14.00',
      cost: '80.50',
      duration: 129,
    },
  ])(
    'calculates exact representative $name price, cost, minimum, and duration',
    ({ service, subtotal, minimum, cost, duration }) => {
      const result = calculateEstimate(pricingRequest(service()));

      expect(result.quoteable).toBe(true);
      expect(result.serviceSubtotal.amount).toBe(subtotal);
      expect(result.minimumAdjustment.amount).toBe(minimum);
      expect(result.estimatedCost.amount).toBe(cost);
      expect(result.durationMinutes).toBe(duration);
      expect(result.issues).toEqual([]);
      expect(result.approvalFlags).toEqual([]);
    },
  );

  it.each([
    {
      packageCode: 'ESSENTIAL_CARE' as const,
      services: [driveway()],
      selectedOptionalServices: [],
      selectedOptionalAddOns: [],
      subtotal: '215.00',
      tax: '18.56',
      total: '243.56',
      deposit: '60.89',
    },
    {
      packageCode: 'CURB_APPEAL_PLUS' as const,
      services: [driveway(), gutters(), house(), windows()],
      selectedOptionalServices: [],
      selectedOptionalAddOns: [{ serviceCode: 'gutter-cleaning', addOnCode: 'DOWNSPOUT_FLUSH' }],
      subtotal: '1077.36',
      tax: '88.88',
      total: '1166.24',
      deposit: '291.56',
    },
    {
      packageCode: 'WHOLE_PROPERTY_CARE' as const,
      services: [driveway(), gutters(), house(), windows(), roof()],
      selectedOptionalServices: [],
      selectedOptionalAddOns: [],
      subtotal: '1528.36',
      tax: '126.09',
      total: '1654.45',
      deposit: '413.61',
    },
  ])(
    'prices the exact $packageCode package scope without inventing measurements',
    ({
      packageCode,
      services,
      selectedOptionalServices,
      selectedOptionalAddOns,
      subtotal,
      tax,
      total,
      deposit,
    }) => {
      const result = calculatePackageEstimate(
        packageRequest(
          packageCode,
          services,
          selectedOptionalServices,
          EXTERIOR_SERVICE_CODES,
          selectedOptionalAddOns,
        ),
      );

      expect(result.quoteable).toBe(true);
      expect(result.packageTier).toBe(
        packageCode === 'ESSENTIAL_CARE'
          ? 'good'
          : packageCode === 'CURB_APPEAL_PLUS'
            ? 'better'
            : 'best',
      );
      expect(result.serviceSubtotal.amount).toBe(subtotal);
      expect(result.tax.amount).toBe(tax);
      expect(result.total.amount).toBe(total);
      expect(result.depositRequired.amount).toBe(deposit);
      expect(result.issues).toEqual([]);
    },
  );

  it('fails closed when a package add-on has no explicit measured quantity', () => {
    const gutterWithoutDownspouts = {
      ...gutters(),
      addOns: [],
    };
    const result = calculatePackageEstimate(
      packageRequest(
        'WHOLE_PROPERTY_CARE',
        [driveway(), gutterWithoutDownspouts],
        [],
        ['pressure-wash-flatwork', 'gutter-cleaning'],
      ),
    );

    expect(result.quoteable).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'PACKAGE_SCOPE_INVALID',
        serviceCode: 'gutter-cleaning',
        message: expect.stringContaining('explicit measured quantity'),
      }),
    );
  });

  it('calculates but blocks an elevated-risk scope for explicit owner review', () => {
    const steepRoof = roof();
    steepRoof.attributes = {
      ...steepRoof.attributes,
      roof_pitch: 'steep',
    };
    const result = calculateEstimate(pricingRequest(steepRoof));

    expect(result.serviceSubtotal.amount).toBe('699.05');
    expect(result.quoteable).toBe(false);
    expect(result.approvalFlags).toContainEqual(
      expect.objectContaining({
        reason: 'outside_sop',
        blocking: true,
        summary: expect.stringContaining('Steep-pitch'),
      }),
    );
  });
});
