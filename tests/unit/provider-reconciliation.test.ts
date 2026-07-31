import { describe, expect, it } from 'vitest';
import {
  ProviderReconciliationError,
  centsToDecimal,
  decimalToCents,
  nextDeliveryStatus,
  nextPaymentStatus,
  parseEmailReconciliation,
  parseStripeReconciliation,
  parseTwilioReconciliation,
} from '@/core/integrations/providerReconciliation';
import { SupabaseLiveOutboundPolicy } from '@/core/integrations/liveOutboundPolicy';

const companyId = '10000000-0000-4000-8000-000000000001';
const quoteId = '10000000-0000-4000-8000-000000000501';
const jobId = '10000000-0000-4000-8000-000000000601';
const approvalId = '10000000-0000-4000-8000-000000000801';

describe('provider webhook reconciliation contracts', () => {
  it('parses a paid checkout only from app-created company and quote metadata', () => {
    const parsed = parseStripeReconciliation({
      id: 'evt_checkout_paid',
      type: 'checkout.session.completed',
      created: 1_785_259_200,
      data: {
        object: {
          id: 'cs_live_redacted',
          payment_intent: 'pi_live_redacted',
          payment_status: 'paid',
          amount_total: 61_356,
          currency: 'usd',
          customer_email: 'must-not-persist@example.com',
          customer_details: { phone: '+12145550123' },
          metadata: {
            company_id: companyId,
            quote_id: quoteId,
            checkout_purpose: 'quote_deposit',
            checkout_attempt: '1',
          },
        },
      },
    });

    expect(parsed).toMatchObject({
      providerEventId: 'evt_checkout_paid',
      objectKind: 'checkout',
      action: 'payment_succeeded',
      companyId,
      quoteId,
      checkoutPurpose: 'quote_deposit',
      checkoutAttempt: 1,
      paymentIntentId: 'pi_live_redacted',
      amountCents: 61_356,
    });
    const durableReceipt = JSON.stringify(parsed.receipt);
    expect(durableReceipt).not.toContain('must-not-persist');
    expect(durableReceipt).not.toContain('+12145550123');
  });

  it('binds invoice-balance checkout events to the exact invoice version', () => {
    const invoiceId = '10000000-0000-4000-8000-000000000701';
    const parsed = parseStripeReconciliation({
      id: 'evt_invoice_balance_paid',
      type: 'checkout.session.completed',
      created: 1_785_259_200,
      data: {
        object: {
          id: 'cs_live_invoice_balance',
          payment_intent: 'pi_live_invoice_balance',
          payment_status: 'paid',
          amount_total: 48_124,
          currency: 'usd',
          metadata: {
            company_id: companyId,
            quote_id: quoteId,
            checkout_purpose: 'invoice_balance',
            checkout_attempt: '7',
            invoice_id: invoiceId,
            invoice_version: '7',
          },
        },
      },
    });

    expect(parsed).toMatchObject({
      objectKind: 'checkout',
      action: 'payment_succeeded',
      checkoutPurpose: 'invoice_balance',
      checkoutAttempt: 7,
      invoiceId,
      invoiceVersion: 7,
    });
    expect(parsed.receipt).toMatchObject({
      checkoutPurpose: 'invoice_balance',
      checkoutAttempt: 7,
      invoiceId,
      invoiceVersion: 7,
    });
  });

  it('requires job metadata and authoritative paid amounts for Stripe invoices', () => {
    const parsed = parseStripeReconciliation({
      id: 'evt_invoice_paid',
      type: 'invoice.paid',
      created: 1_785_259_200,
      data: {
        object: {
          id: 'in_live_redacted',
          status: 'paid',
          payment_intent: 'pi_live_redacted',
          amount_due: 61_356,
          amount_paid: 61_356,
          amount_remaining: 0,
          currency: 'usd',
          metadata: { company_id: companyId, job_id: jobId },
        },
      },
    });

    expect(parsed).toMatchObject({
      objectKind: 'invoice',
      action: 'invoice_paid',
      jobId,
      amountPaidCents: 61_356,
      amountRemainingCents: 0,
    });
  });

  it('requires an approved StoryOps reference on refund events', () => {
    const parsed = parseStripeReconciliation({
      id: 'evt_refund',
      type: 'refund.updated',
      created: 1_785_259_200,
      data: {
        object: {
          id: 're_live_redacted',
          payment_intent: 'pi_live_redacted',
          status: 'succeeded',
          amount: 12_500,
          currency: 'usd',
          metadata: { company_id: companyId, approval_id: approvalId },
        },
      },
    });
    expect(parsed).toMatchObject({
      objectKind: 'refund',
      action: 'refund_succeeded',
      approvalId,
      paymentIntentId: 'pi_live_redacted',
      amountCents: 12_500,
    });

    expect(() =>
      parseStripeReconciliation({
        id: 'evt_refund_without_approval',
        type: 'refund.updated',
        data: {
          object: {
            id: 're_untrusted',
            status: 'succeeded',
            amount: 12_500,
            currency: 'usd',
            metadata: { company_id: companyId },
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ProviderReconciliationError>>({
        code: 'MISSING_REFERENCE',
      }),
    );
  });

  it('fails closed on malformed company scope, references, currency, and amounts', () => {
    const baseEvent = {
      id: 'evt_invalid',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_invalid',
          amount: 100,
          currency: 'usd',
          metadata: {
            company_id: companyId,
            quote_id: quoteId,
            checkout_purpose: 'quote_deposit',
            checkout_attempt: '1',
          },
        },
      },
    };

    expect(() =>
      parseStripeReconciliation({
        ...baseEvent,
        data: {
          object: {
            ...baseEvent.data.object,
            metadata: { company_id: 'not-a-company', quote_id: quoteId },
          },
        },
      }),
    ).toThrow(/invalid company_id/u);
    expect(() =>
      parseStripeReconciliation({
        ...baseEvent,
        data: {
          object: {
            ...baseEvent.data.object,
            metadata: { company_id: companyId, quote_id: 'quote-from-client' },
          },
        },
      }),
    ).toThrow(/invalid quote_id/u);
    expect(() =>
      parseStripeReconciliation({
        ...baseEvent,
        data: { object: { ...baseEvent.data.object, currency: 'eur' } },
      }),
    ).toThrow(/only USD/u);
    expect(() =>
      parseStripeReconciliation({
        ...baseEvent,
        data: { object: { ...baseEvent.data.object, amount: 10.5 } },
      }),
    ).toThrow(/invalid amount/u);
    expect(() =>
      parseStripeReconciliation({
        ...baseEvent,
        created: 'not-a-provider-timestamp',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ProviderReconciliationError>>({
        code: 'INVALID_TIMESTAMP',
      }),
    );
    expect(() =>
      parseStripeReconciliation({
        ...baseEvent,
        data: {
          object: {
            ...baseEvent.data.object,
            metadata: { company_id: companyId, quote_id: quoteId },
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ProviderReconciliationError>>({
        code: 'MISSING_REFERENCE',
      }),
    );
    expect(() =>
      parseStripeReconciliation({
        ...baseEvent,
        data: {
          object: {
            ...baseEvent.data.object,
            metadata: {
              company_id: companyId,
              quote_id: quoteId,
              checkout_purpose: 'quote_deposit',
            },
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ProviderReconciliationError>>({
        code: 'MISSING_REFERENCE',
      }),
    );
    expect(() =>
      parseStripeReconciliation({
        ...baseEvent,
        data: {
          object: {
            ...baseEvent.data.object,
            metadata: {
              ...baseEvent.data.object.metadata,
              checkout_attempt: '0',
            },
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ProviderReconciliationError>>({
        code: 'INVALID_REFERENCE',
      }),
    );
    expect(() =>
      parseStripeReconciliation({
        ...baseEvent,
        data: {
          object: {
            ...baseEvent.data.object,
            metadata: {
              company_id: companyId,
              quote_id: quoteId,
              checkout_purpose: 'invoice_balance',
              checkout_attempt: '1',
              invoice_id: '10000000-0000-4000-8000-000000000701',
              invoice_version: 'not-an-integer',
            },
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ProviderReconciliationError>>({
        code: 'INVALID_REFERENCE',
      }),
    );
  });

  it('uses a status-qualified Twilio event key and stores only a sender fingerprint', async () => {
    const first = await parseTwilioReconciliation(
      {
        MessageSid: 'SM123',
        To: '+12145550172',
        From: '+12145550100',
        Body: 'STOP',
      },
      companyId,
    );
    const second = await parseTwilioReconciliation(
      { MessageSid: 'SM123', MessageStatus: 'delivered' },
      companyId,
    );

    expect(first).toMatchObject({
      providerEventId: 'SM123:inbound_message',
      consentSignal: 'opt_out',
      contactFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(second.providerEventId).toBe('SM123:delivered');
    const durableReceipt = JSON.stringify(first.receipt);
    expect(durableReceipt).not.toContain('STOP');
    expect(durableReceipt).not.toContain('+1214555');
  });

  it('parses the generic email contract without persisting recipients or content', () => {
    const parsed = parseEmailReconciliation({
      id: 'email-event-1',
      type: 'delivery',
      status: 'delivered',
      company_id: companyId,
      message_id: 'email-message-1',
      occurred_at: '2026-07-28T17:00:00.000Z',
      recipient: 'must-not-persist@example.com',
      subject: 'must not persist',
      body: 'must not persist',
    });

    expect(parsed).toMatchObject({
      provider: 'email',
      deliveryStatus: 'delivered',
      providerMessageId: 'email-message-1',
    });
    expect(JSON.stringify(parsed.receipt)).not.toContain('must-not-persist');
  });

  it('keeps delivery reconciliation monotonic under duplicate and out-of-order callbacks', () => {
    expect(nextDeliveryStatus('queued', 'sent')).toBe('sent');
    expect(nextDeliveryStatus('sent', 'queued')).toBe('sent');
    expect(nextDeliveryStatus('delivered', 'failed')).toBe('delivered');
    expect(nextDeliveryStatus('failed', 'sent')).toBe('failed');
    expect(nextDeliveryStatus('failed', 'delivered')).toBe('delivered');
    expect(nextDeliveryStatus('received', 'delivered')).toBe('received');
  });

  it('does not let late payment callbacks undo provider success or refunds', () => {
    expect(nextPaymentStatus('pending', 'failed')).toBe('failed');
    expect(nextPaymentStatus('failed', 'succeeded')).toBe('succeeded');
    expect(nextPaymentStatus('succeeded', 'failed')).toBe('succeeded');
    expect(nextPaymentStatus('refunded', 'succeeded')).toBe('refunded');
    expect(nextPaymentStatus('partially_refunded', 'pending')).toBe('partially_refunded');
  });

  it('converts provider cents without floating-point money arithmetic', () => {
    expect(centsToDecimal(61_356)).toBe('613.56');
    expect(decimalToCents('613.56')).toBe(61_356);
    expect(decimalToCents('613.5')).toBe(61_350);
    expect(() => decimalToCents('613.567')).toThrow(/two-decimal/u);
    expect(() => centsToDecimal(1.5)).toThrow(/safe integer/u);
  });

  it('authorizes live SMS through a contact-free consent decision RPC', async () => {
    const calls: Array<{ functionName: string; parameters: Record<string, unknown> }> = [];
    const client = {
      rpc: async (functionName: string, parameters: Record<string, unknown>) => {
        calls.push({ functionName, parameters });
        if (functionName === 'authorize_outbound_contact') {
          return {
            data: [
              {
                allowed: true,
                decision_code: 'ALLOWED',
                consent_record_id: 'consent-active',
                latest_consent_record_id: 'consent-active',
              },
            ],
            error: null,
          };
        }
        return {
          data: [
            {
              allowed: true,
              used: 1,
              remaining: 9,
              reset_at: '2026-07-28T18:01:00.000Z',
            },
          ],
          error: null,
        };
      },
    };
    const policy = new SupabaseLiveOutboundPolicy(client as never, {
      companyPerMinute: 10,
      smsPerContactPerHour: 3,
      emailPerContactPerHour: 3,
      voicePerContactPerHour: 1,
    });

    await expect(
      policy.authorizeSms({
        companyId,
        to: '+1 (214) 555-0999',
        body: 'A policy-authorized transactional message.',
        category: 'transactional',
        consentSnapshotId: 'consent-active',
        idempotencyKey: 'allowed-live-sms',
      }),
    ).resolves.toBeUndefined();

    expect(calls.map((call) => call.functionName)).toEqual([
      'authorize_outbound_contact',
      'consume_operation_budget',
      'consume_operation_budget',
    ]);
    expect(calls[0]?.parameters).toMatchObject({
      p_company_id: companyId,
      p_channel: 'sms',
      p_purpose: 'transactional',
      p_consent_snapshot_id: 'consent-active',
      p_contact_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(calls[0]?.parameters)).not.toContain('214');
  });

  it('blocks an outbound SMS prepared against consent that STOP has superseded', async () => {
    const calls: string[] = [];
    const client = {
      rpc: async (functionName: string) => {
        calls.push(functionName);
        return {
          data: [
            {
              allowed: false,
              decision_code: 'STALE_CONSENT',
              consent_record_id: 'consent-granted-before-stop',
              latest_consent_record_id: 'consent-withdrawn-by-stop',
            },
          ],
          error: null,
        };
      },
    };
    const policy = new SupabaseLiveOutboundPolicy(client as never, {
      companyPerMinute: 10,
      smsPerContactPerHour: 3,
      emailPerContactPerHour: 3,
      voicePerContactPerHour: 1,
    });

    await expect(
      policy.authorizeSms({
        companyId,
        to: '+12145550999',
        body: 'A message that must remain blocked.',
        category: 'transactional',
        consentSnapshotId: 'consent-granted-before-stop',
        idempotencyKey: 'blocked-after-stop',
      }),
    ).rejects.toMatchObject({ code: 'STALE_CONSENT' });
    expect(calls).toEqual(['authorize_outbound_contact']);
  });
});
