import { describe, expect, it } from 'vitest';
import { hasPermission, type Permission } from '@/domain';
import { buildWorkspaceSearchItems, searchWorkspaceItems } from '@/core/workspaceSearch';
import { createDemoState } from '@/state/demoSeed';
import type { AppRole } from '@/state/model';

const permissionsFor = (role: AppRole) => (permission: Permission) =>
  hasPermission(role, permission);

describe('role-scoped workspace search', () => {
  it('indexes every authoritative sandbox record class with stable exact-record destinations', () => {
    const items = buildWorkspaceSearchItems(createDemoState(), permissionsFor('owner'));

    expect(items.filter((item) => item.kind === 'customer')).toHaveLength(5);
    expect(items.filter((item) => item.kind === 'lead')).toHaveLength(6);
    expect(items.filter((item) => item.kind === 'visit')).toHaveLength(2);
    expect(items.filter((item) => item.kind === 'invoice')).toHaveLength(3);
    expect(items.filter((item) => item.kind === 'estimate')).toHaveLength(1);
    expect(items.filter((item) => item.kind === 'price_book')).toHaveLength(1);
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);

    expect(items.find((item) => item.key === 'customer:cameron')?.href).toBe(
      '/customers?customer=cameron',
    );
    expect(items.find((item) => item.key === 'invoice:invoice-1021')?.href).toBe(
      '/finance?invoice=invoice-1021',
    );
  });

  it('matches normalized multi-field terms and ranks exact record numbers first', () => {
    const state = createDemoState();
    const firstLead = state.leads[0];
    if (!firstLead) throw new Error('Search fixtures require at least one lead.');
    firstLead.name = 'José Núñez';
    const items = buildWorkspaceSearchItems(state, permissionsFor('owner'));

    expect(searchWorkspaceItems(items, 'INV 1021').map((item) => item.key)).toEqual([
      'invoice:invoice-1021',
    ]);
    expect(searchWorkspaceItems(items, 'cameron 469').map((item) => item.key)).toEqual([
      'customer:cameron',
    ]);
    expect(searchWorkspaceItems(items, 'southlake 76092').map((item) => item.key)).toContain(
      'lead:lead-riley',
    );
    expect(searchWorkspaceItems(items, 'jose nunez').map((item) => item.key)).toContain(
      'lead:lead-morgan',
    );
  });

  it('never indexes invoice, estimate, or price-book records for a technician', () => {
    const items = buildWorkspaceSearchItems(createDemoState(), permissionsFor('technician'));

    expect(items.some((item) => item.kind === 'customer')).toBe(true);
    expect(items.some((item) => item.kind === 'visit')).toBe(true);
    expect(items.some((item) => item.kind === 'invoice')).toBe(false);
    expect(items.some((item) => item.kind === 'estimate')).toBe(false);
    expect(items.some((item) => item.kind === 'price_book')).toBe(false);
    expect(searchWorkspaceItems(items, 'INV-1021')).toEqual([]);
  });
});
