import type { MessageCategory } from './contracts.ts';
import { IntegrationError } from './contracts.ts';

export type ContactChannel = 'sms' | 'email' | 'voice';
export type ConsentStatus = 'unknown' | 'opted_in' | 'opted_out';

export type ConsentSnapshot = {
  id: string;
  contact: string;
  channel: ContactChannel;
  transactional: ConsentStatus;
  marketing: ConsentStatus;
  source: string;
  recordedAt: string;
};

export interface ConsentStore {
  get(contact: string, channel: ContactChannel): Promise<ConsentSnapshot | undefined>;
  save(snapshot: ConsentSnapshot): Promise<void>;
}

export class InMemoryConsentStore implements ConsentStore {
  private readonly snapshots = new Map<string, ConsentSnapshot>();

  async get(contact: string, channel: ContactChannel): Promise<ConsentSnapshot | undefined> {
    return this.snapshots.get(`${channel}:${normalizeContact(contact, channel)}`);
  }

  async save(snapshot: ConsentSnapshot): Promise<void> {
    this.snapshots.set(
      `${snapshot.channel}:${normalizeContact(snapshot.contact, snapshot.channel)}`,
      structuredClone(snapshot),
    );
  }
}

const optOutWords = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const optInWords = new Set(['start', 'unstop', 'subscribe']);

export function classifyConsentKeyword(message: string): 'opt_out' | 'opt_in' | 'none' {
  const normalized = message.trim().toLowerCase().replace(/[.!]/g, '');
  if (optOutWords.has(normalized)) return 'opt_out';
  if (optInWords.has(normalized)) return 'opt_in';
  return 'none';
}

export function normalizeContact(contact: string, channel: ContactChannel): string {
  if (channel === 'email') return contact.trim().toLowerCase();
  const digits = contact.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (contact.trim().startsWith('+') && digits.length >= 8) return `+${digits}`;
  throw new IntegrationError(`Invalid ${channel} contact.`, 'consent', 'INVALID_CONTACT', false);
}

export async function contactFingerprint(
  contact: string,
  channel: ContactChannel,
): Promise<string> {
  const normalized = normalizeContact(contact, channel);
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(normalized),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function recordInboundConsentKeyword(options: {
  store: ConsentStore;
  contact: string;
  channel: 'sms';
  message: string;
  providerMessageId: string;
  now?: Date;
}): Promise<ConsentSnapshot | undefined> {
  const classification = classifyConsentKeyword(options.message);
  if (classification === 'none') return undefined;
  const now = options.now ?? new Date();
  const status = classification === 'opt_out' ? 'opted_out' : 'opted_in';
  const snapshot: ConsentSnapshot = {
    id: globalThis.crypto.randomUUID(),
    contact: normalizeContact(options.contact, options.channel),
    channel: options.channel,
    transactional: status,
    marketing: status,
    source: `inbound_keyword:${options.providerMessageId}`,
    recordedAt: now.toISOString(),
  };
  await options.store.save(snapshot);
  return snapshot;
}

export async function assertContactAllowed(options: {
  store: ConsentStore;
  contact: string;
  channel: ContactChannel;
  category: MessageCategory;
}): Promise<ConsentSnapshot> {
  const snapshot = await options.store.get(options.contact, options.channel);
  if (!snapshot) {
    throw new IntegrationError(
      'No consent record exists for this contact and channel.',
      'consent',
      'CONSENT_UNKNOWN',
      false,
    );
  }
  const status = options.category === 'marketing' ? snapshot.marketing : snapshot.transactional;
  if (status !== 'opted_in') {
    throw new IntegrationError(
      `Contact is ${status.replace('_', ' ')} for ${options.category} ${options.channel}.`,
      'consent',
      status === 'opted_out' ? 'OPTED_OUT' : 'CONSENT_UNKNOWN',
      false,
    );
  }
  return snapshot;
}

export function isWithinQuietHours(options: {
  at: Date;
  timeZone: string;
  quietStartHour?: number;
  quietEndHour?: number;
}): boolean {
  const quietStart = options.quietStartHour ?? 20;
  const quietEnd = options.quietEndHour ?? 8;
  const hourText = new Intl.DateTimeFormat('en-US', {
    timeZone: options.timeZone,
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(options.at);
  const hour = Number.parseInt(hourText, 10);
  return quietStart > quietEnd
    ? hour >= quietStart || hour < quietEnd
    : hour >= quietStart && hour < quietEnd;
}
