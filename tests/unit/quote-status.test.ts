import { describe, expect, it } from 'vitest';
import { customerFacingQuoteStatus } from '@/utils/quoteStatus';

describe('customer-facing quote status', () => {
  it('maps the legacy sent compatibility value to truthful portal publication wording', () => {
    expect(customerFacingQuoteStatus('sent')).toBe('published to portal');
    expect(customerFacingQuoteStatus('viewed')).toBe('viewed');
    expect(customerFacingQuoteStatus('change_requested')).toBe('change requested');
  });
});
