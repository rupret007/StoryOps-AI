import type {
  DomainId,
  EntityMetadata,
  ISODate,
  ISODateTime,
  Money,
  RetentionMetadata,
} from './primitives.ts';

export interface InvoiceLine {
  description: string;
  quantity: string;
  unitPrice: Money;
  subtotal: Money;
  taxable: boolean;
  jobId?: DomainId;
}

export interface Invoice extends EntityMetadata {
  invoiceNumber: string;
  customerId: DomainId;
  jobId?: DomainId;
  status: 'draft' | 'open' | 'paid' | 'past_due' | 'void' | 'uncollectible';
  providerInvoiceId?: string;
  issueDate: ISODate;
  dueDate: ISODate;
  lines: readonly InvoiceLine[];
  subtotal: Money;
  tax: Money;
  total: Money;
  amountPaid: Money;
  balanceDue: Money;
  sentAt?: ISODateTime;
  paidAt?: ISODateTime;
}

export interface Payment extends EntityMetadata {
  invoiceId: DomainId;
  customerId: DomainId;
  provider: 'stripe' | 'cash' | 'check' | 'other';
  providerPaymentId?: string;
  type: 'deposit' | 'invoice' | 'refund';
  status: 'pending' | 'succeeded' | 'failed' | 'refunded' | 'partially_refunded';
  amount: Money;
  processedAt?: ISODateTime;
  failureCode?: string;
  idempotencyKey: string;
}

export interface CommunicationThread extends EntityMetadata {
  customerId?: DomainId;
  leadId?: DomainId;
  subject?: string;
  status: 'open' | 'waiting' | 'closed';
  assignedUserId?: DomainId;
  lastMessageAt: ISODateTime;
}

export interface CommunicationMessage extends EntityMetadata {
  threadId: DomainId;
  channel: 'sms' | 'email' | 'voice' | 'chat' | 'portal';
  direction: 'inbound' | 'outbound';
  sender: string;
  recipients: readonly string[];
  body: string;
  providerMessageId?: string;
  deliveryStatus: 'queued' | 'sent' | 'delivered' | 'failed' | 'received';
  consentRecordId?: DomainId;
  sentByUserId?: DomainId;
  sentByAgent?: string;
  approvalRequestId?: DomainId;
  receivedAt?: ISODateTime;
  sentAt?: ISODateTime;
  retention: RetentionMetadata;
}

export interface Campaign extends EntityMetadata {
  name: string;
  channel: 'sms' | 'email';
  status: 'draft' | 'pending_approval' | 'scheduled' | 'running' | 'paused' | 'complete';
  audienceDefinition: string;
  templateVersion: string;
  scheduledAt?: ISODateTime;
  sentCount: number;
  deliveredCount: number;
  optOutCount: number;
  approvalRequestId?: DomainId;
}

export interface Review extends EntityMetadata {
  customerId?: DomainId;
  jobId?: DomainId;
  provider: 'google' | 'facebook' | 'internal' | 'other';
  providerReviewId?: string;
  rating: number;
  body?: string;
  receivedAt: ISODateTime;
  sentiment: 'positive' | 'neutral' | 'negative' | 'unknown';
  responseStatus: 'not_needed' | 'drafted' | 'pending_approval' | 'posted';
  responseText?: string;
  approvalRequestId?: DomainId;
}

export interface Referral extends EntityMetadata {
  referrerCustomerId: DomainId;
  referredLeadId?: DomainId;
  referredCustomerId?: DomainId;
  status: 'invited' | 'converted' | 'reward_pending' | 'rewarded' | 'expired';
  rewardDescription?: string;
  convertedAt?: ISODateTime;
}

export interface Notification extends EntityMetadata {
  recipientUserId?: DomainId;
  recipientCustomerId?: DomainId;
  kind:
    | 'approval_required'
    | 'booking_changed'
    | 'weather_alert'
    | 'payment'
    | 'incident'
    | 'integration'
    | 'system';
  title: string;
  body: string;
  actionUrl?: string;
  readAt?: ISODateTime;
}
