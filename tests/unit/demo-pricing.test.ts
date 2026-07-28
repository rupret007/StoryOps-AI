import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { calculateDemoPrice, summarizeDemoServiceTotals } from '@/data/priceBook';
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
});
