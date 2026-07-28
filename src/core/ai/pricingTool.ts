import { z } from 'zod';
import { asDecimalString, asDomainId, asISODateTime, money, type PriceBook } from '@/domain';
import { calculateEstimate, type PricingResult } from '@/core/pricing';
import type { OfficeToolRegistry } from './tools.ts';

const serviceSchema = z.object({
  serviceCode: z.string().min(1).max(100),
  quantity: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
  attributes: z
    .object({
      stories: z.string().max(50).optional(),
      surface: z.string().max(100).optional(),
      soil: z.string().max(100).optional(),
      access: z.string().max(100).optional(),
      risk: z.string().max(100).optional(),
    })
    .strict(),
  addOns: z
    .array(
      z.object({
        code: z.string().min(1).max(100),
        quantity: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
      }),
    )
    .max(50),
  sourceMeasurementIds: z.array(z.string().uuid()).min(1).max(100),
});

const pricingToolInputSchema = z.object({
  companyId: z.string().uuid(),
  propertyId: z.string().uuid(),
  priceBookId: z.string().uuid().optional(),
  services: z.array(serviceSchema).min(1).max(50),
  travelZoneCode: z.string().max(100).optional(),
  discount: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none'), reason: z.string().max(500).optional() }),
    z.object({
      kind: z.literal('percent'),
      value: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
      reason: z.string().min(1).max(500),
    }),
    z.object({
      kind: z.literal('fixed'),
      amount: z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/),
      reason: z.string().min(1).max(500),
    }),
  ]),
  customerTaxExempt: z.boolean(),
  scopeEvidenceDisposition: z.enum(['usable_for_scope', 'human_review_required', 'insufficient']),
});

export type PricingToolInput = z.infer<typeof pricingToolInputSchema>;

export type ApprovedPriceBookLoader = (options: {
  companyId: string;
  priceBookId?: string;
}) => Promise<PriceBook>;

export function registerDeterministicPricingTool(
  registry: OfficeToolRegistry,
  options: {
    loadApprovedPriceBook: ApprovedPriceBookLoader;
    now?: () => Date;
  },
): OfficeToolRegistry {
  const now = options.now ?? (() => new Date());
  registry.register<PricingToolInput, PricingResult>({
    name: 'pricing.calculate',
    description:
      'Calculate an estimate with the server-loaded approved price book. The caller cannot supply prices or formulas.',
    input: pricingToolInputSchema,
    risk: 'low',
    sideEffect: 'none',
    reversible: true,
    supportsIdempotency: true,
    autoExecute: true,
    async execute(input, context) {
      if (input.companyId !== context.companyId) {
        throw new Error('Pricing company does not match the authenticated tool context.');
      }
      const priceBook = await options.loadApprovedPriceBook({
        companyId: input.companyId,
        priceBookId: input.priceBookId,
      });
      if (priceBook.companyId !== input.companyId) {
        throw new Error('Loaded price book belongs to a different company.');
      }

      return calculateEstimate({
        requestId: `${context.runId}:${context.actionId}`,
        companyId: asDomainId(input.companyId),
        propertyId: asDomainId(input.propertyId),
        priceBook,
        services: input.services.map((service) => ({
          serviceCode: service.serviceCode,
          quantity: asDecimalString(service.quantity),
          attributes: service.attributes,
          addOns: service.addOns.map((addOn) => ({
            code: addOn.code,
            quantity: asDecimalString(addOn.quantity),
          })),
          sourceMeasurementIds: service.sourceMeasurementIds.map(asDomainId),
        })),
        travelZoneCode: input.travelZoneCode,
        discount:
          input.discount.kind === 'none'
            ? { kind: 'none', reason: input.discount.reason }
            : input.discount.kind === 'percent'
              ? {
                  kind: 'percent',
                  value: asDecimalString(input.discount.value),
                  reason: input.discount.reason,
                }
              : {
                  kind: 'fixed',
                  value: money(input.discount.amount),
                  reason: input.discount.reason,
                },
        customerTaxExempt: input.customerTaxExempt,
        scopeEvidenceDisposition: input.scopeEvidenceDisposition,
        calculatedAt: asISODateTime(now().toISOString()),
      });
    },
  });
  return registry;
}
