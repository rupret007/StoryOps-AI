import type { Permission } from '@/domain';
import { sandboxCustomerRecords } from '@/data/sandboxCustomers';
import type { DemoState } from '@/state/model';

export type WorkspaceSearchKind =
  'customer' | 'lead' | 'visit' | 'invoice' | 'estimate' | 'price_book';

export interface WorkspaceSearchItem {
  key: string;
  recordId: string;
  kind: WorkspaceSearchKind;
  title: string;
  meta: string;
  href: string;
  searchText: string;
}

type PermissionCheck = (permission: Permission) => boolean;

const normalizeSearchText = (value: string): string =>
  value
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('en-US')
    .replaceAll(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replaceAll(/\s+/gu, ' ');

const makeItem = (
  kind: WorkspaceSearchKind,
  recordId: string,
  title: string,
  meta: string,
  href: string,
  extraTerms: readonly string[] = [],
): WorkspaceSearchItem => ({
  key: `${kind}:${recordId}`,
  recordId,
  kind,
  title,
  meta,
  href,
  searchText: normalizeSearchText([title, meta, ...extraTerms].join(' ')),
});

/**
 * Builds the search index only from records already visible in this role's
 * workspace. Permissions are checked before a record class is indexed, so the
 * palette never becomes a side door to a hidden module.
 */
export function buildWorkspaceSearchItems(
  state: DemoState,
  can: PermissionCheck,
): WorkspaceSearchItem[] {
  const items: WorkspaceSearchItem[] = [];

  if (can('customers.read')) {
    const customers =
      state.dataMode === 'supabase' ? (state.live?.customers ?? []) : sandboxCustomerRecords;
    for (const customer of customers) {
      items.push(
        makeItem(
          'customer',
          customer.id,
          customer.name,
          `Customer · ${customer.address}`,
          `/customers?customer=${encodeURIComponent(customer.id)}`,
          [customer.email, customer.phone, customer.status],
        ),
      );
    }

    for (const lead of state.leads) {
      items.push(
        makeItem(
          'lead',
          lead.id,
          lead.name,
          `Lead · ${lead.service} · ${lead.stage.replaceAll('_', ' ')}`,
          `/pipeline?lead=${encodeURIComponent(lead.id)}`,
          [lead.address, lead.city, lead.phone, lead.email, lead.source, lead.note],
        ),
      );
    }
  }

  if (can('jobs.read')) {
    for (const visit of state.visits) {
      items.push(
        makeItem(
          'visit',
          visit.id,
          visit.jobNumber,
          `Visit · ${visit.customerName} · ${visit.status.replaceAll('_', ' ')}`,
          '/field',
          [visit.address, visit.service, visit.date, visit.crew],
        ),
      );
    }
  }

  if (can('invoices.read')) {
    for (const invoice of state.invoices) {
      items.push(
        makeItem(
          'invoice',
          invoice.id,
          invoice.number,
          `Invoice · ${invoice.customerName} · ${invoice.status.replaceAll('_', ' ')}`,
          `/finance?invoice=${encodeURIComponent(invoice.id)}`,
          [invoice.jobNumber, invoice.issueDate, invoice.dueDate, invoice.total, invoice.balance],
        ),
      );
    }
  }

  if (can('estimates.read') && state.estimate.id) {
    items.push(
      makeItem(
        'estimate',
        state.estimate.id,
        state.estimate.estimateNumber,
        `Estimate · ${state.estimate.status.replaceAll('_', ' ')} · $${state.estimate.total}`,
        `/estimates/${encodeURIComponent(state.estimate.id)}`,
        [state.estimate.leadId, state.estimate.priceBookVersion],
      ),
    );
  }

  if (can('price_books.read') && state.estimate.priceBookVersion) {
    items.push(
      makeItem(
        'price_book',
        state.estimate.priceBookVersion,
        state.estimate.priceBookVersion,
        'Active price book',
        '/operations',
      ),
    );
  }

  return items;
}

function itemRank(item: WorkspaceSearchItem, normalizedQuery: string, tokens: readonly string[]) {
  const title = normalizeSearchText(item.title);
  const meta = normalizeSearchText(item.meta);
  if (title === normalizedQuery) return 0;
  if (title.startsWith(normalizedQuery)) return 10;
  if (title.includes(normalizedQuery)) return 20;
  if (meta.startsWith(normalizedQuery)) return 30;
  if (meta.includes(normalizedQuery)) return 40;
  return 50 + tokens.reduce((score, token) => score + item.searchText.indexOf(token), 0);
}

/** Every normalized query token must match. Results are then ranked deterministically. */
export function searchWorkspaceItems(
  items: readonly WorkspaceSearchItem[],
  query: string,
): WorkspaceSearchItem[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [...items];
  const tokens = normalizedQuery.split(' ');
  return items
    .filter((item) => tokens.every((token) => item.searchText.includes(token)))
    .map((item, index) => ({ item, index, rank: itemRank(item, normalizedQuery, tokens) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ item }) => item);
}
