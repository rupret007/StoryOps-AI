import { z } from 'zod';
import {
  classifyConsentKeyword,
  normalizeContact,
  type ContactChannel,
} from '../integrations/consent.ts';
import { IntegrationError } from '../integrations/contracts.ts';
import { sha256TextHex, verifyTimestampedHmacWebhook } from '../integrations/webhooks.ts';

export const LEAD_INTAKE_JSON_MAX_BYTES = 64 * 1_024;
export const LEAD_INTAKE_TWILIO_MAX_BYTES = 32 * 1_024;
export const LEAD_INTAKE_MAX_MESSAGE_CHARACTERS = 8_000;
export const LEAD_INTAKE_MAX_REQUESTED_SERVICES = 12;
export const LEAD_INTAKE_SANDBOX_SECRET = 'storyops-local-sandbox-only';
export const TWILIO_INTAKE_SANDBOX_TOKEN = 'storyops-twilio-local-sandbox-only';

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const optionalEmail = z.string().trim().email().max(320).optional();
const optionalPhone = z.string().trim().min(8).max(32).optional();
const serviceCode = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/u, 'Service requests must use explicit catalog codes.');

const explicitConsentSchema = z
  .object({
    channel: z.enum(['sms', 'email', 'voice']),
    purpose: z.enum(['transactional', 'marketing']),
    status: z.enum(['granted', 'withdrawn', 'unknown']),
    captureMethod: z.enum(['web_form', 'keyword', 'written', 'verbal', 'imported']),
    disclosureVersion: boundedText(80),
    proof: boundedText(2_000),
  })
  .strict();

export const signedLeadIntakeSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: boundedText(255),
    companyId: z.string().uuid(),
    source: z.enum(['web', 'chat', 'email']),
    occurredAt: z.string().datetime({ offset: true }).optional(),
    lead: z
      .object({
        displayName: boundedText(160).optional(),
        email: optionalEmail,
        phone: optionalPhone,
        requestedServices: z.array(serviceCode).max(LEAD_INTAKE_MAX_REQUESTED_SERVICES).default([]),
        preferredContactChannel: z.enum(['email', 'sms', 'phone']).optional(),
      })
      .strict()
      .refine(
        (value) => Boolean(value.displayName || value.email || value.phone),
        'Lead must include a display name, email, or phone.',
      ),
    message: z
      .object({
        sender: boundedText(320).optional(),
        recipients: z.array(boundedText(320)).max(10).default([]),
        body: boundedText(LEAD_INTAKE_MAX_MESSAGE_CHARACTERS),
        subject: boundedText(300).optional(),
      })
      .strict(),
    consent: z.array(explicitConsentSchema).max(6).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.source === 'email' && !value.lead.email) {
      context.addIssue({
        code: 'custom',
        path: ['lead', 'email'],
        message: 'Email intake requires a lead email.',
      });
    }
    if (value.lead.preferredContactChannel === 'email' && !value.lead.email) {
      context.addIssue({
        code: 'custom',
        path: ['lead', 'preferredContactChannel'],
        message: 'Email preference requires a lead email.',
      });
    }
    if (
      (value.lead.preferredContactChannel === 'sms' ||
        value.lead.preferredContactChannel === 'phone') &&
      !value.lead.phone
    ) {
      context.addIssue({
        code: 'custom',
        path: ['lead', 'preferredContactChannel'],
        message: 'SMS or phone preference requires a lead phone.',
      });
    }
    const seen = new Set<string>();
    for (const record of value.consent) {
      const key = `${record.channel}:${record.purpose}`;
      if (seen.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['consent'],
          message: `Consent contains duplicate ${key} assertions.`,
        });
      }
      seen.add(key);
      if (record.channel === 'email' && !value.lead.email) {
        context.addIssue({
          code: 'custom',
          path: ['consent'],
          message: 'Email consent requires a lead email.',
        });
      }
      if ((record.channel === 'sms' || record.channel === 'voice') && !value.lead.phone) {
        context.addIssue({
          code: 'custom',
          path: ['consent'],
          message: `${record.channel} consent requires a lead phone.`,
        });
      }
    }
  });

export type SignedLeadIntake = z.infer<typeof signedLeadIntakeSchema>;
export type IntakeSource = SignedLeadIntake['source'] | 'sms' | 'phone';
export type IntakeCommunicationChannel = 'sms' | 'email' | 'voice' | 'chat';

export type NormalizedIntakeConsent = {
  channel: ContactChannel;
  purpose: 'transactional' | 'marketing';
  status: 'granted' | 'withdrawn' | 'unknown';
  captureMethod: 'web_form' | 'keyword' | 'written' | 'verbal' | 'imported';
  disclosureVersion: string;
  proof: string;
};

export type NormalizedLeadIntake = {
  companyId: string;
  provider: 'storyops_web' | 'storyops_chat' | 'storyops_email' | 'twilio';
  providerEventId: string;
  eventType: 'inbound_web' | 'inbound_chat' | 'inbound_email' | 'inbound_sms' | 'inbound_voice';
  source: IntakeSource;
  occurredAt: string;
  displayName: string;
  email?: string;
  phone?: string;
  requestedServices: string[];
  preferredContactChannel?: 'email' | 'sms' | 'phone';
  communication: {
    channel: IntakeCommunicationChannel;
    sender: string;
    recipients: string[];
    body: string;
    subject?: string;
  };
  consent: NormalizedIntakeConsent[];
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeEmail(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

function normalizedPhone(value: string | undefined, channel: 'sms' | 'voice'): string | undefined {
  return value ? normalizeContact(value, channel) : undefined;
}

function senderMatchesPhone(sender: string | undefined, phone: string | undefined): boolean {
  if (!sender || !phone) return false;
  try {
    return normalizedPhone(sender, 'sms') === phone;
  } catch {
    return false;
  }
}

function implicitUnknownConsent(
  channel: ContactChannel | undefined,
  proof: string,
): NormalizedIntakeConsent[] {
  if (!channel) return [];
  return (['transactional', 'marketing'] as const).map((purpose) => ({
    channel,
    purpose,
    status: 'unknown',
    captureMethod: 'imported',
    disclosureVersion: 'none-presented',
    proof,
  }));
}

function channelForPreferredContact(
  preferred: SignedLeadIntake['lead']['preferredContactChannel'],
): ContactChannel | undefined {
  if (preferred === 'phone') return 'voice';
  return preferred;
}

export function parseSignedLeadIntake(
  rawBody: string,
  maxBytes = LEAD_INTAKE_JSON_MAX_BYTES,
): SignedLeadIntake {
  if (new TextEncoder().encode(rawBody).byteLength > maxBytes) {
    throw new IntegrationError(
      'Lead intake payload exceeds the configured limit.',
      'lead_intake',
      'PAYLOAD_TOO_LARGE',
      false,
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch (error) {
    throw new IntegrationError(
      'Lead intake payload is not valid JSON.',
      'lead_intake',
      'INVALID_JSON',
      false,
      { cause: error },
    );
  }

  const result = signedLeadIntakeSchema.safeParse(decoded);
  if (!result.success) {
    throw new IntegrationError(
      'Lead intake payload does not match schema version 1.',
      'lead_intake',
      'INVALID_INTAKE',
      false,
      { cause: result.error },
    );
  }
  return result.data;
}

export async function verifySignedLeadIntake(options: {
  rawBody: string;
  signatureHeader: string;
  signingSecret: string;
  now?: Date;
  toleranceSeconds?: number;
}): Promise<{ timestamp: number }> {
  if (!options.signingSecret) {
    throw new IntegrationError(
      'Lead intake signing secret is not configured.',
      'lead_intake',
      'SIGNING_SECRET_MISSING',
      false,
    );
  }
  const verification = await verifyTimestampedHmacWebhook(options);
  if (!verification.valid || verification.timestamp === null) {
    throw new IntegrationError(
      'Lead intake signature is invalid or stale.',
      'lead_intake',
      'INVALID_SIGNATURE',
      false,
    );
  }
  return { timestamp: verification.timestamp };
}

export function normalizeSignedLeadIntake(
  input: SignedLeadIntake,
  receivedAt = new Date(),
): NormalizedLeadIntake {
  if (input.occurredAt) {
    const occurredAt = new Date(input.occurredAt).getTime();
    const drift = occurredAt - receivedAt.getTime();
    if (drift > 5 * 60_000 || drift < -30 * 24 * 60 * 60_000) {
      throw new IntegrationError(
        'Lead intake occurredAt falls outside the accepted evidence window.',
        'lead_intake',
        'INVALID_EVENT_TIME',
        false,
      );
    }
  }
  const email = normalizeEmail(input.lead.email);
  const phone = normalizedPhone(input.lead.phone, 'sms');
  const displayName = (input.lead.displayName ?? email ?? phone ?? input.message.sender)?.trim();
  if (!displayName) {
    throw new IntegrationError(
      'Lead has no stable display identity.',
      'lead_intake',
      'MISSING_IDENTITY',
      false,
    );
  }

  if (
    input.source === 'email' &&
    email &&
    input.message.sender &&
    normalizeEmail(input.message.sender) !== email
  ) {
    throw new IntegrationError(
      'Email sender must match the lead email.',
      'lead_intake',
      'SENDER_MISMATCH',
      false,
    );
  }

  const preferredConsentChannel =
    channelForPreferredContact(input.lead.preferredContactChannel) ??
    (input.source === 'email' ? 'email' : undefined);
  const consent =
    input.consent.length > 0
      ? input.consent.map((record) => ({ ...record }))
      : implicitUnknownConsent(
          preferredConsentChannel,
          `No consent assertion supplied in signed ${input.source} event ${input.eventId}.`,
        );
  const statedSender = input.message.sender?.trim();
  const sender =
    input.source === 'email'
      ? email!
      : senderMatchesPhone(statedSender, phone)
        ? phone!
        : email && statedSender && normalizeEmail(statedSender) === email
          ? email
          : (statedSender ?? phone ?? email ?? displayName);

  return {
    companyId: input.companyId,
    provider: `storyops_${input.source}`,
    providerEventId: input.eventId,
    eventType: `inbound_${input.source}`,
    source: input.source,
    occurredAt: input.occurredAt ?? receivedAt.toISOString(),
    displayName,
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    requestedServices: unique(input.lead.requestedServices),
    ...(input.lead.preferredContactChannel
      ? { preferredContactChannel: input.lead.preferredContactChannel }
      : {}),
    communication: {
      channel: input.source === 'email' ? 'email' : 'chat',
      sender,
      recipients: unique(input.message.recipients.map((recipient) => recipient.trim())),
      body: input.message.body.trim(),
      ...(input.message.subject ? { subject: input.message.subject.trim() } : {}),
    },
    consent,
  };
}

function assertTwilioFormBounds(form: Record<string, string>): void {
  const entries = Object.entries(form);
  if (entries.length > 64) {
    throw new IntegrationError(
      'Twilio form contains too many fields.',
      'twilio',
      'PAYLOAD_TOO_LARGE',
      false,
    );
  }
  for (const [key, value] of entries) {
    if (key.length > 128 || value.length > LEAD_INTAKE_MAX_MESSAGE_CHARACTERS) {
      throw new IntegrationError(
        'Twilio form field exceeds the configured limit.',
        'twilio',
        'PAYLOAD_TOO_LARGE',
        false,
      );
    }
  }
}

function requiredTwilioField(form: Record<string, string>, key: string, maximum: number): string {
  const value = form[key]?.trim();
  if (!value || value.length > maximum) {
    throw new IntegrationError(
      `Twilio ${key} is missing or invalid.`,
      'twilio',
      'INVALID_INTAKE',
      false,
    );
  }
  return value;
}

function twilioKeywordConsent(body: string, messageId: string): NormalizedIntakeConsent[] {
  const classification = classifyConsentKeyword(body);
  const status =
    classification === 'opt_out'
      ? 'withdrawn'
      : classification === 'opt_in'
        ? 'granted'
        : 'unknown';
  return (['transactional', 'marketing'] as const).map((purpose) => ({
    channel: 'sms',
    purpose,
    status,
    captureMethod: classification === 'none' ? 'imported' : 'keyword',
    disclosureVersion: classification === 'none' ? 'none-presented' : 'twilio-keyword-policy-v1',
    proof:
      classification === 'none'
        ? `Inbound SMS ${messageId}; no opt-in or opt-out keyword asserted.`
        : `Inbound ${classification} keyword in Twilio message ${messageId}.`,
  }));
}

export function normalizeTwilioLeadIntake(
  form: Record<string, string>,
  companyId: string,
  receivedAt = new Date(),
): NormalizedLeadIntake {
  assertTwilioFormBounds(form);
  const isSms = Boolean(form.MessageSid);
  const isVoice = Boolean(form.CallSid);
  if (isSms === isVoice) {
    throw new IntegrationError(
      'Twilio intake must contain exactly one MessageSid or CallSid.',
      'twilio',
      'INVALID_INTAKE',
      false,
    );
  }

  if (form.Direction && !form.Direction.toLowerCase().startsWith('inbound')) {
    throw new IntegrationError(
      'Outbound Twilio callbacks cannot create leads.',
      'twilio',
      'NOT_INBOUND',
      false,
    );
  }

  const channel = isSms ? 'sms' : 'voice';
  const from = normalizeContact(requiredTwilioField(form, 'From', 32), channel);
  const to = normalizeContact(requiredTwilioField(form, 'To', 32), channel);

  if (isSms) {
    const messageId = requiredTwilioField(form, 'MessageSid', 255);
    const body = requiredTwilioField(form, 'Body', LEAD_INTAKE_MAX_MESSAGE_CHARACTERS);
    const messageStatus = form.SmsStatus ?? form.MessageStatus;
    if (messageStatus !== 'received') {
      throw new IntegrationError(
        'Twilio SMS intake must carry provider status received.',
        'twilio',
        'NOT_INBOUND',
        false,
      );
    }
    return {
      companyId,
      provider: 'twilio',
      providerEventId: messageId,
      eventType: 'inbound_sms',
      source: 'sms',
      occurredAt: receivedAt.toISOString(),
      displayName: from,
      phone: from,
      requestedServices: [],
      preferredContactChannel: 'sms',
      communication: {
        channel: 'sms',
        sender: from,
        recipients: [to],
        body,
      },
      consent: twilioKeywordConsent(body, messageId),
    };
  }

  const callId = requiredTwilioField(form, 'CallSid', 255);
  if (!form.Direction?.toLowerCase().startsWith('inbound')) {
    throw new IntegrationError(
      'Twilio voice intake must carry an inbound direction.',
      'twilio',
      'NOT_INBOUND',
      false,
    );
  }
  const speech = (form.SpeechResult ?? form.TranscriptionText)?.trim();
  const body = speech
    ? speech.slice(0, LEAD_INTAKE_MAX_MESSAGE_CHARACTERS)
    : '[Inbound voice call; no transcript supplied by Twilio]';
  return {
    companyId,
    provider: 'twilio',
    providerEventId: callId,
    eventType: 'inbound_voice',
    source: 'phone',
    occurredAt: receivedAt.toISOString(),
    displayName: from,
    phone: from,
    requestedServices: [],
    preferredContactChannel: 'phone',
    communication: {
      channel: 'voice',
      sender: from,
      recipients: [to],
      body,
    },
    consent: implicitUnknownConsent(
      'voice',
      `Inbound Twilio call ${callId}; no consent assertion supplied.`,
    ),
  };
}

export async function deterministicIntakeUuid(
  companyId: string,
  provider: string,
  providerEventId: string,
  recordKind: string,
): Promise<string> {
  const hash = await sha256TextHex(
    ['storyops.lead-intake.v1', companyId, provider, providerEventId, recordKind].join('\u001f'),
  );
  const characters = hash.slice(0, 32).split('');
  characters[12] = '5';
  const variant = Number.parseInt(characters[16] ?? '0', 16);
  characters[16] = ((variant & 0x3) | 0x8).toString(16);
  const value = characters.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function intakeReceiptPayload(event: NormalizedLeadIntake): Record<string, unknown> {
  return {
    schemaVersion: 1,
    source: event.source,
    channel: event.communication.channel,
    hasEmail: Boolean(event.email),
    hasPhone: Boolean(event.phone),
    requestedServiceCodes: event.requestedServices,
    consentSignals: event.consent.map(({ channel, purpose, status }) => ({
      channel,
      purpose,
      status,
    })),
  };
}

export function isLocalSandboxRequest(requestUrl: string): boolean {
  const hostname = new URL(requestUrl).hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
