import type { SupabaseClient } from '@supabase/supabase-js';
import { Decimal } from 'decimal.js';
import type { CreateCheckoutRequest, CreateInvoiceRequest, RefundRequest } from './contracts.ts';
import { IntegrationError } from './contracts.ts';

function lineTotal(lines: CreateCheckoutRequest['lines']): Decimal {
  return lines.reduce(
    (total, line) => total.plus(new Decimal(line.unitAmount.amount).mul(line.quantity)),
    new Decimal(0),
  );
}

export interface StripeBillingValidator {
  validateCheckout(request: CreateCheckoutRequest): Promise<void>;
  validateInvoice(request: CreateInvoiceRequest): Promise<void>;
  validateRefund(request: RefundRequest): Promise<void>;
}

export class SupabaseStripeBillingValidator implements StripeBillingValidator {
  constructor(private readonly client: SupabaseClient) {}

  async validateCheckout(request: CreateCheckoutRequest): Promise<void> {
    const { data, error } = await this.client
      .from('quotes')
      .select('id,customer_id,status,total,deposit_required,valid_until')
      .eq('id', request.quoteId)
      .eq('company_id', request.companyId)
      .maybeSingle();
    if (error) {
      throw new IntegrationError(
        `Quote validation failed: ${error.message}`,
        'stripe',
        'BILLING_VALIDATION_FAILED',
        true,
      );
    }
    const quote = data as {
      id: string;
      customer_id: string;
      status: string;
      total: number | string;
      deposit_required: number | string;
      valid_until: string;
    } | null;
    if (
      !quote ||
      quote.customer_id !== request.customerId ||
      quote.status !== 'accepted' ||
      new Date(`${quote.valid_until}T23:59:59.999Z`).getTime() < Date.now()
    ) {
      throw new IntegrationError(
        'Checkout requires a current accepted quote belonging to the supplied customer.',
        'stripe',
        'QUOTE_NOT_PAYABLE',
        false,
      );
    }
    const deposit = new Decimal(quote.deposit_required);
    const expected = deposit.gt(0) ? deposit : new Decimal(quote.total);
    if (!lineTotal(request.lines).eq(expected)) {
      throw new IntegrationError(
        'Checkout lines do not equal the accepted quote’s deterministic payable amount.',
        'stripe',
        'AMOUNT_MISMATCH',
        false,
      );
    }
  }

  async validateInvoice(request: CreateInvoiceRequest): Promise<void> {
    const { data, error } = await this.client
      .from('invoices')
      .select('id,customer_id,status,due_date,total')
      .eq('company_id', request.companyId)
      .eq('job_id', request.jobId)
      .in('status', ['draft', 'open'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      throw new IntegrationError(
        `Invoice validation failed: ${error.message}`,
        'stripe',
        'BILLING_VALIDATION_FAILED',
        true,
      );
    }
    const invoice = data as {
      id: string;
      customer_id: string;
      status: string;
      due_date: string;
      total: number | string;
    } | null;
    if (
      !invoice ||
      invoice.customer_id !== request.customerId ||
      invoice.due_date !== request.dueDate
    ) {
      throw new IntegrationError(
        'Provider invoice requires a matching current StoryOps invoice and due date.',
        'stripe',
        'INVOICE_NOT_ISSUABLE',
        false,
      );
    }
    if (!lineTotal(request.lines).eq(new Decimal(invoice.total))) {
      throw new IntegrationError(
        'Provider invoice lines do not equal the authoritative StoryOps invoice total.',
        'stripe',
        'AMOUNT_MISMATCH',
        false,
      );
    }
  }

  async validateRefund(request: RefundRequest): Promise<void> {
    const { data, error } = await this.client
      .from('payments')
      .select('id,status,amount,provider_payment_id')
      .eq('company_id', request.companyId)
      .eq('provider', 'stripe')
      .eq('provider_payment_id', request.paymentProviderId)
      .maybeSingle();
    if (error) {
      throw new IntegrationError(
        `Refund validation failed: ${error.message}`,
        'stripe',
        'BILLING_VALIDATION_FAILED',
        true,
      );
    }
    const payment = data as {
      status: string;
      amount: number | string;
      provider_payment_id: string;
    } | null;
    if (
      !payment ||
      !['succeeded', 'partially_refunded'].includes(payment.status) ||
      new Decimal(request.amount.amount).gt(new Decimal(payment.amount))
    ) {
      throw new IntegrationError(
        'Refund amount or provider payment does not match an eligible StoryOps payment.',
        'stripe',
        'REFUND_NOT_ALLOWED',
        false,
      );
    }
  }
}
