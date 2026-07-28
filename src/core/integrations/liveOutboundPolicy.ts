import type { SupabaseClient } from '@supabase/supabase-js';
import type { CreateVoiceCallRequest, SendEmailRequest, SendSmsRequest } from './contracts.ts';
import { IntegrationError } from './contracts.ts';
import { contactFingerprint, normalizeContact, type ContactChannel } from './consent.ts';
import { consumeOperationBudget } from './operationBudget.ts';

type OutboundAuthorizationDecision = {
  allowed: boolean;
  decision_code: string;
  consent_record_id: string | null;
  latest_consent_record_id: string | null;
};

export type OutboundPolicyLimits = {
  companyPerMinute: number;
  smsPerContactPerHour: number;
  emailPerContactPerHour: number;
  voicePerContactPerHour: number;
};

export interface LiveOutboundPolicy {
  authorizeSms(request: SendSmsRequest): Promise<void>;
  authorizeEmail(request: SendEmailRequest): Promise<void>;
  authorizeVoice(request: CreateVoiceCallRequest): Promise<void>;
}

export class SupabaseLiveOutboundPolicy implements LiveOutboundPolicy {
  constructor(
    private readonly client: SupabaseClient,
    private readonly limits: OutboundPolicyLimits,
  ) {}

  private async authorize(options: {
    companyId: string;
    contact: string;
    channel: ContactChannel;
    category: 'transactional' | 'marketing';
    consentSnapshotId: string;
    perContactLimit: number;
  }): Promise<void> {
    const normalizedContact = normalizeContact(options.contact, options.channel);
    const fingerprint = await contactFingerprint(normalizedContact, options.channel);
    const { data, error } = await this.client.rpc('authorize_outbound_contact', {
      p_company_id: options.companyId,
      p_channel: options.channel,
      p_purpose: options.category,
      p_contact_fingerprint: fingerprint,
      p_consent_snapshot_id: options.consentSnapshotId,
    });
    if (error) {
      throw new IntegrationError(
        'Consent authorization is unavailable.',
        'consent',
        'CONSENT_UNAVAILABLE',
        true,
        { cause: error },
      );
    }
    const rows = Array.isArray(data) ? data : [];
    const decision =
      rows.length === 1 && rows[0] !== null && typeof rows[0] === 'object'
        ? (rows[0] as OutboundAuthorizationDecision)
        : undefined;
    if (
      !decision ||
      typeof decision.allowed !== 'boolean' ||
      typeof decision.decision_code !== 'string' ||
      (decision.consent_record_id !== null && typeof decision.consent_record_id !== 'string') ||
      (decision.latest_consent_record_id !== null &&
        typeof decision.latest_consent_record_id !== 'string')
    ) {
      throw new IntegrationError(
        'Consent authorization returned an invalid decision.',
        'consent',
        'CONSENT_UNAVAILABLE',
        true,
      );
    }
    if (decision.allowed) {
      if (
        decision.decision_code !== 'ALLOWED' ||
        decision.consent_record_id !== options.consentSnapshotId ||
        decision.latest_consent_record_id !== options.consentSnapshotId
      ) {
        throw new IntegrationError(
          'Consent authorization returned inconsistent evidence.',
          'consent',
          'CONSENT_UNAVAILABLE',
          true,
        );
      }
    } else {
      const denial = {
        CONSENT_NOT_GRANTED: {
          code: 'CONSENT_NOT_GRANTED',
          message: 'The exact consent snapshot is not an active grant.',
        },
        STALE_CONSENT: {
          code: 'STALE_CONSENT',
          message: 'Consent changed after this message was prepared.',
        },
        OPTED_OUT: {
          code: 'OPTED_OUT',
          message: 'The contact is suppressed.',
        },
        CONTACT_MISMATCH: {
          code: 'CONSENT_CONTACT_MISMATCH',
          message: 'The consent evidence does not match the outbound contact.',
        },
      }[decision.decision_code];
      throw new IntegrationError(
        denial?.message ?? 'Consent authorization returned an unknown denial.',
        'consent',
        denial?.code ?? 'CONSENT_UNAVAILABLE',
        denial === undefined,
      );
    }

    const companyBudget = await consumeOperationBudget({
      client: this.client,
      companyId: options.companyId,
      scope: `outbound:${options.channel}:company`,
      subject: options.companyId,
      limit: this.limits.companyPerMinute,
      windowSeconds: 60,
    });
    if (!companyBudget.allowed) {
      throw new IntegrationError(
        `Company outbound rate limit exceeded until ${companyBudget.reset_at}.`,
        'communications',
        'RATE_LIMITED',
        true,
      );
    }
    const contactBudget = await consumeOperationBudget({
      client: this.client,
      companyId: options.companyId,
      scope: `outbound:${options.channel}:contact`,
      subject: normalizedContact,
      limit: options.perContactLimit,
      windowSeconds: 3_600,
    });
    if (!contactBudget.allowed) {
      throw new IntegrationError(
        `Contact outbound rate limit exceeded until ${contactBudget.reset_at}.`,
        'communications',
        'RATE_LIMITED',
        true,
      );
    }
  }

  authorizeSms(request: SendSmsRequest): Promise<void> {
    return this.authorize({
      companyId: request.companyId,
      contact: request.to,
      channel: 'sms',
      category: request.category,
      consentSnapshotId: request.consentSnapshotId,
      perContactLimit: this.limits.smsPerContactPerHour,
    });
  }

  async authorizeEmail(request: SendEmailRequest): Promise<void> {
    for (const contact of request.to) {
      const snapshotId =
        request.consentSnapshotIds[contact] ??
        request.consentSnapshotIds[normalizeContact(contact, 'email')];
      if (!snapshotId) {
        throw new IntegrationError(
          'Every email recipient requires an exact consent snapshot.',
          'consent',
          'CONSENT_UNKNOWN',
          false,
        );
      }
      await this.authorize({
        companyId: request.companyId,
        contact,
        channel: 'email',
        category: request.category,
        consentSnapshotId: snapshotId,
        perContactLimit: this.limits.emailPerContactPerHour,
      });
    }
  }

  authorizeVoice(request: CreateVoiceCallRequest): Promise<void> {
    return this.authorize({
      companyId: request.companyId,
      contact: request.to,
      channel: 'voice',
      category: 'transactional',
      consentSnapshotId: request.consentSnapshotId,
      perContactLimit: this.limits.voicePerContactPerHour,
    });
  }
}
