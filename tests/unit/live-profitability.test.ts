import { describe, expect, it } from 'vitest';
import {
  actualCostCoverage,
  formatCurrencyDecimal,
  formatPercentDecimal,
  liveProfitabilityKpisSchema,
  sourceIdSummary,
} from '@/core/finance/profitability';
import { mapLiveWorkspace } from '@/state/liveWorkspaceMapper';
import { makeLiveProfitabilityKpis } from '../fixtures/live-profitability';

const companyId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';

describe('live profitability projection', () => {
  it('keeps every database aggregate as a decimal string through validation and display', () => {
    const projection = makeLiveProfitabilityKpis(companyId);
    const parsed = liveProfitabilityKpisSchema.parse(projection);

    expect(formatCurrencyDecimal(parsed.revenue.invoicedSubtotal)).toBe('$487.76');
    expect(formatCurrencyDecimal('123456789012345.67')).toBe('$123,456,789,012,345.67');
    expect(formatCurrencyDecimal('-1234.5')).toBe('-$1,234.50');
    expect(formatPercentDecimal(parsed.profitability.actualGrossMarginPercent)).toBe('72.3%');
    expect(actualCostCoverage(parsed)).toBe('1/1 invoiced jobs cost-complete');
    expect(sourceIdSummary(parsed)).toContain('1 provider events');

    expect(() =>
      liveProfitabilityKpisSchema.parse({
        ...projection,
        revenue: { ...projection.revenue, invoicedSubtotal: 487.76 },
      }),
    ).toThrow();
  });

  it('preserves partial actual-cost facts while withholding actual profit and margin', () => {
    const projection = liveProfitabilityKpisSchema.parse(
      makeLiveProfitabilityKpis(companyId, { complete: false }),
    );

    expect(projection.costs.recordedActualMaterial).toBe('50.00');
    expect(projection.costs.recordedActualLabor).toBeNull();
    expect(projection.costs.actualTotal).toBeNull();
    expect(projection.profitability.actualGrossProfit).toBeNull();
    expect(projection.profitability.actualGrossMarginPercent).toBeNull();
    expect(projection.completeness.complete).toBe(false);
    expect(projection.completeness.unknowns[0]).toMatch(/no labor cost is inferred/u);
    expect(formatPercentDecimal(projection.profitability.actualGrossMarginPercent)).toBe(
      'Unavailable',
    );
    expect(actualCostCoverage(projection)).toBe('0/1 invoiced jobs cost-complete');
  });

  it('maps the server projection only into live metadata and never reconstructs it client-side', () => {
    const profitabilityKpis = makeLiveProfitabilityKpis(companyId);
    const state = mapLiveWorkspace({
      schemaVersion: 'storyops-workspace-v1',
      serverTime: profitabilityKpis.asOf,
      session: { userId, companyId, role: 'owner' },
      company: {
        id: companyId,
        name: 'Live Service Company',
        timezone: 'America/Chicago',
        currency: 'USD',
        status: 'active',
        settings: {},
        version: 1,
      },
      profitabilityKpis,
    });

    expect(state.live?.profitabilityKpis).toEqual(profitabilityKpis);
    expect(state.live?.profitabilityKpis?.evidence.sourceFingerprint).toBe('a'.repeat(64));
  });
});
