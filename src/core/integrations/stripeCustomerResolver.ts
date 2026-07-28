import type { SupabaseClient } from '@supabase/supabase-js';
import { IntegrationError } from './contracts.ts';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type StripeCustomerIdentity = {
  companyId: string;
  customerId: string;
  name: string;
  email: string;
  identityFingerprint: string;
  stripeCustomerId?: string;
};

export interface StripeCustomerResolver {
  resolve(companyId: string, customerId: string): Promise<StripeCustomerIdentity>;
  save(identity: StripeCustomerIdentity & { stripeCustomerId: string }): Promise<void>;
}

export class SupabaseStripeCustomerResolver implements StripeCustomerResolver {
  constructor(private readonly client: SupabaseClient) {}

  async resolve(companyId: string, customerId: string): Promise<StripeCustomerIdentity> {
    const { data, error } = await this.client.rpc('resolve_stripe_billing_identity', {
      p_company_id: companyId,
      p_customer_id: customerId,
    });
    if (error) {
      throw new IntegrationError(
        'Stripe billing identity resolution is unavailable.',
        'stripe',
        'CUSTOMER_RESOLUTION_FAILED',
        true,
        { cause: error },
      );
    }
    const rows = Array.isArray(data) ? data : [];
    const row =
      rows.length === 1 && rows[0] !== null && typeof rows[0] === 'object'
        ? (rows[0] as Record<string, unknown>)
        : undefined;
    if (!row || typeof row.eligible !== 'boolean' || typeof row.decision_code !== 'string') {
      throw new IntegrationError(
        'Stripe billing identity RPC returned an invalid decision.',
        'stripe',
        'CUSTOMER_RESOLUTION_FAILED',
        true,
      );
    }
    if (!row.eligible) {
      const code =
        row.decision_code === 'INVALID_MAPPING'
          ? 'INVALID_CUSTOMER_MAPPING'
          : row.decision_code === 'COMPANY_INACTIVE'
            ? 'COMPANY_INACTIVE'
            : 'CUSTOMER_NOT_BILLABLE';
      throw new IntegrationError(
        'Stripe checkout/invoicing requires an active company customer with a billing identity.',
        'stripe',
        code,
        false,
      );
    }
    const providerCustomerId =
      typeof row.provider_customer_id === 'string' ? row.provider_customer_id : undefined;
    if (
      row.decision_code !== 'ELIGIBLE' ||
      row.customer_id !== customerId ||
      typeof row.billing_name !== 'string' ||
      row.billing_name.trim().length === 0 ||
      typeof row.billing_email !== 'string' ||
      row.billing_email.trim().length === 0 ||
      typeof row.identity_fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(row.identity_fingerprint) ||
      (row.provider_customer_id !== null && typeof row.provider_customer_id !== 'string') ||
      (providerCustomerId !== undefined && !/^cus_[A-Za-z0-9]+$/u.test(providerCustomerId))
    ) {
      throw new IntegrationError(
        'Stripe billing identity RPC returned invalid or inconsistent evidence.',
        'stripe',
        'CUSTOMER_RESOLUTION_FAILED',
        true,
      );
    }
    return {
      companyId,
      customerId,
      name: row.billing_name,
      email: row.billing_email,
      identityFingerprint: row.identity_fingerprint,
      stripeCustomerId: providerCustomerId,
    };
  }

  async save(identity: StripeCustomerIdentity & { stripeCustomerId: string }): Promise<void> {
    if (
      !/^cus_[A-Za-z0-9]+$/u.test(identity.stripeCustomerId) ||
      !/^[a-f0-9]{64}$/u.test(identity.identityFingerprint)
    ) {
      throw new IntegrationError(
        'Stripe returned invalid customer mapping evidence.',
        'stripe',
        'INVALID_RESPONSE',
        false,
      );
    }
    const { data, error } = await this.client.rpc('save_stripe_customer_mapping', {
      p_company_id: identity.companyId,
      p_customer_id: identity.customerId,
      p_provider_customer_id: identity.stripeCustomerId,
      p_identity_fingerprint: identity.identityFingerprint,
    });
    if (error) {
      throw new IntegrationError(
        'Stripe customer mapping could not be persisted.',
        'stripe',
        'CUSTOMER_MAPPING_FAILED',
        true,
        { cause: error },
      );
    }
    const rows = Array.isArray(data) ? data : [];
    const row =
      rows.length === 1 && rows[0] !== null && typeof rows[0] === 'object'
        ? (rows[0] as Record<string, unknown>)
        : undefined;
    if (!row || typeof row.saved !== 'boolean' || typeof row.decision_code !== 'string') {
      throw new IntegrationError(
        'Stripe customer mapping RPC returned an invalid decision.',
        'stripe',
        'CUSTOMER_MAPPING_FAILED',
        true,
      );
    }
    if (!row.saved) {
      const retryable = row.decision_code === 'IDENTITY_STALE';
      throw new IntegrationError(
        retryable
          ? 'Stripe billing identity changed before its mapping was saved.'
          : 'Stripe customer mapping conflicts with authoritative local evidence.',
        'stripe',
        row.decision_code === 'IDENTITY_STALE'
          ? 'STALE_CUSTOMER_IDENTITY'
          : row.decision_code === 'COMPANY_INACTIVE'
            ? 'COMPANY_INACTIVE'
            : row.decision_code === 'CUSTOMER_NOT_BILLABLE'
              ? 'CUSTOMER_NOT_BILLABLE'
              : 'CUSTOMER_MAPPING_CONFLICT',
        retryable,
      );
    }
    if (
      row.decision_code !== 'SAVED' ||
      typeof row.mapping_id !== 'string' ||
      !uuidPattern.test(row.mapping_id) ||
      row.provider_customer_id !== identity.stripeCustomerId
    ) {
      throw new IntegrationError(
        'Stripe customer mapping RPC returned inconsistent evidence.',
        'stripe',
        'CUSTOMER_MAPPING_FAILED',
        true,
      );
    }
  }
}
