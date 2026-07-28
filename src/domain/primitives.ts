import { z } from 'zod';

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type DomainId = Brand<string, 'DomainId'>;
export type ISODate = Brand<string, 'ISODate'>;
export type ISODateTime = Brand<string, 'ISODateTime'>;
export type DecimalString = Brand<string, 'DecimalString'>;
export type MoneyString = Brand<string, 'MoneyString'>;
export type PercentageString = Brand<string, 'PercentageString'>;

export const domainIdSchema = z
  .string()
  .uuid()
  .transform((value) => value as DomainId);
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), 'Invalid ISO date')
  .transform((value) => value as ISODate);
export const isoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => value as ISODateTime);
export const decimalStringSchema = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u, 'Must be a base-10 decimal string')
  .transform((value) => value as DecimalString);
export const nonNegativeDecimalStringSchema = decimalStringSchema.refine(
  (value) => !value.startsWith('-'),
  'Must be non-negative',
);
export const moneyStringSchema = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)\.\d{2}$/u, 'Money must have exactly two decimal places')
  .transform((value) => value as MoneyString);
export const percentageStringSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u, 'Must be a non-negative base-10 decimal string')
  .refine((value) => Number(value) <= 100, 'Percentage cannot exceed 100')
  .transform((value) => value as PercentageString);

export const asDomainId = (value: string): DomainId => domainIdSchema.parse(value);
export const asISODate = (value: string): ISODate => isoDateSchema.parse(value);
export const asISODateTime = (value: string): ISODateTime => isoDateTimeSchema.parse(value);
export const asDecimalString = (value: string): DecimalString => decimalStringSchema.parse(value);
export const asMoneyString = (value: string): MoneyString => moneyStringSchema.parse(value);
export const asPercentageString = (value: string): PercentageString =>
  percentageStringSchema.parse(value);

export type CurrencyCode = 'USD';

export interface Money {
  amount: MoneyString;
  currency: CurrencyCode;
}

export interface GeoPoint {
  latitude: DecimalString;
  longitude: DecimalString;
}

export interface PostalAddress {
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  country: 'US';
  geo?: GeoPoint;
}

export interface EntityMetadata {
  id: DomainId;
  companyId: DomainId;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  version: number;
}

export interface ActorReference {
  actorType: 'user' | 'customer' | 'agent' | 'system' | 'provider';
  actorId: DomainId | string;
}

export interface IdempotencyContext {
  key: string;
  scope: string;
  requestHash: string;
  requestedAt: ISODateTime;
}

export interface RetentionMetadata {
  retentionClass: 'operational' | 'financial' | 'safety' | 'communication' | 'ai_trace' | 'audit';
  retainUntil?: ISODateTime;
  legalHold: boolean;
}

export const money = (amount: string): Money => ({
  amount: asMoneyString(amount),
  currency: 'USD',
});
