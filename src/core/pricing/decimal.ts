import { Decimal } from 'decimal.js';
import {
  asDecimalString,
  asMoneyString,
  type DecimalString,
  type Money,
  type MoneyString,
} from '@/domain';

export const ZERO = new Decimal(0);
export const ONE_HUNDRED = new Decimal(100);

export const decimal = (value: Decimal.Value): Decimal => new Decimal(value);

export const roundMoney = (value: Decimal.Value): Decimal =>
  decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export const moneyAmount = (value: Decimal.Value): MoneyString =>
  asMoneyString(roundMoney(value).toFixed(2));

export const usd = (value: Decimal.Value): Money => ({
  amount: moneyAmount(value),
  currency: 'USD',
});

export const normalizedDecimal = (value: Decimal.Value): DecimalString => {
  const normalized = decimal(value).toFixed();
  return asDecimalString(normalized === '-0' ? '0' : normalized);
};

export const moneyDecimal = (value: Money): Decimal => {
  if (value.currency !== 'USD') {
    throw new Error(`Unsupported currency: ${String(value.currency)}`);
  }
  return decimal(value.amount);
};
