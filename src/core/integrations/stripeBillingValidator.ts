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
    if (request.checkoutPurpose === 'invoice_balance') {
      const { data, error } = await this.client.rpc('load_storyops_invoice_checkout_validation', {
        p_company_id: request.companyId,
        p_invoice_id: request.invoiceId,
      });
      if (error) {
        throw new IntegrationError(
          `Invoice checkout validation failed: ${error.message}`,
          'stripe',
          'BILLING_VALIDATION_FAILED',
          true,
        );
      }
      const invoice = data as {
        id: string;
        customer_id: string;
        quote_id: string;
        status: string;
        balance_due: number | string;
        version: number;
      } | null;
      if (
        !invoice ||
        invoice.customer_id !== request.customerId ||
        invoice.quote_id !== request.quoteId ||
        !['open', 'past_due'].includes(invoice.status) ||
        invoice.version !== request.invoiceVersion
      ) {
        throw new IntegrationError(
          'Checkout requires the exact current payable invoice for this customer.',
          'stripe',
          'INVOICE_NOT_PAYABLE',
          false,
        );
      }
      if (!lineTotal(request.lines).eq(new Decimal(invoice.balance_due))) {
        throw new IntegrationError(
          'Checkout lines do not equal the authoritative current invoice balance.',
          'stripe',
          'AMOUNT_MISMATCH',
          false,
        );
      }
      return;
    }

    const { data, error } = await this.client.rpc('load_storyops_billing_validation', {
      p_company_id: request.companyId,
      p_operation: 'checkout',
      p_subject: request.quoteId,
      p_approval_id: null,
    });
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
    const { data, error } = await this.client.rpc('load_storyops_billing_validation', {
      p_company_id: request.companyId,
      p_operation: 'invoice',
      p_subject: request.jobId,
      p_approval_id: null,
    });
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
        'Provider invoice requires a matching current WashOps invoice and due date.',
        'stripe',
        'INVOICE_NOT_ISSUABLE',
        false,
      );
    }
    if (!lineTotal(request.lines).eq(new Decimal(invoice.total))) {
      throw new IntegrationError(
        'Provider invoice lines do not equal the authoritative WashOps invoice total.',
        'stripe',
        'AMOUNT_MISMATCH',
        false,
      );
    }
  }

  async validateRefund(request: RefundRequest): Promise<void> {
    const { data, error } = await this.client.rpc('load_storyops_billing_validation', {
      p_company_id: request.companyId,
      p_operation: 'refund',
      p_subject: request.paymentProviderId,
      p_approval_id: request.approvalId,
    });
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
        'Refund amount or provider payment does not match an eligible WashOps payment.',
        'stripe',
        'REFUND_NOT_ALLOWED',
        false,
      );
    }
  }
}
