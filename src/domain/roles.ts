export type UserRole = 'owner' | 'dispatcher' | 'technician' | 'customer';

export type Permission =
  | 'company.manage'
  | 'members.manage'
  | 'customers.read'
  | 'customers.write'
  | 'properties.read'
  | 'properties.write'
  | 'catalog.read'
  | 'catalog.manage'
  | 'price_books.read'
  | 'price_books.manage'
  | 'estimates.read'
  | 'estimates.write'
  | 'estimates.approve'
  | 'jobs.read'
  | 'jobs.write'
  | 'dispatch.manage'
  | 'field.execute'
  | 'equipment.manage'
  | 'materials.read'
  | 'materials.manage'
  | 'safety.manage'
  | 'incidents.report'
  | 'incidents.manage'
  | 'invoices.read'
  | 'invoices.write'
  | 'payments.read'
  | 'payments.manage'
  | 'communications.read'
  | 'communications.send'
  | 'campaigns.manage'
  | 'reviews.manage'
  | 'approvals.read'
  | 'approvals.decide'
  | 'automations.read'
  | 'automations.manage'
  | 'ai_traces.read'
  | 'audit.read'
  | 'analytics.read'
  | 'integrations.manage'
  | 'portal.self.read'
  | 'portal.self.write';

const ownerPermissions: readonly Permission[] = [
  'company.manage',
  'members.manage',
  'customers.read',
  'customers.write',
  'properties.read',
  'properties.write',
  'catalog.read',
  'catalog.manage',
  'price_books.read',
  'price_books.manage',
  'estimates.read',
  'estimates.write',
  'estimates.approve',
  'jobs.read',
  'jobs.write',
  'dispatch.manage',
  'field.execute',
  'equipment.manage',
  'materials.read',
  'materials.manage',
  'safety.manage',
  'incidents.report',
  'incidents.manage',
  'invoices.read',
  'invoices.write',
  'payments.read',
  'payments.manage',
  'communications.read',
  'communications.send',
  'campaigns.manage',
  'reviews.manage',
  'approvals.read',
  'approvals.decide',
  'automations.read',
  'automations.manage',
  'ai_traces.read',
  'audit.read',
  'analytics.read',
  'integrations.manage',
];

const dispatcherPermissions: readonly Permission[] = [
  'customers.read',
  'customers.write',
  'properties.read',
  'properties.write',
  'catalog.read',
  'price_books.read',
  'estimates.read',
  'estimates.write',
  'jobs.read',
  'jobs.write',
  'dispatch.manage',
  'equipment.manage',
  'materials.read',
  'incidents.report',
  'incidents.manage',
  'invoices.read',
  'invoices.write',
  'payments.read',
  'communications.read',
  'communications.send',
  'campaigns.manage',
  'reviews.manage',
  'approvals.read',
  'automations.read',
  'ai_traces.read',
  'analytics.read',
];

const technicianPermissions: readonly Permission[] = [
  'customers.read',
  'properties.read',
  'catalog.read',
  'jobs.read',
  'field.execute',
  'materials.read',
  'incidents.report',
  'communications.read',
];

const customerPermissions: readonly Permission[] = [
  'portal.self.read',
  'portal.self.write',
  'estimates.read',
  'jobs.read',
  'invoices.read',
  'payments.read',
];

export const ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> = {
  owner: ownerPermissions,
  dispatcher: dispatcherPermissions,
  technician: technicianPermissions,
  customer: customerPermissions,
};

export const hasPermission = (role: UserRole, permission: Permission): boolean =>
  ROLE_PERMISSIONS[role].includes(permission);

export const hasEveryPermission = (role: UserRole, permissions: readonly Permission[]): boolean =>
  permissions.every((permission) => hasPermission(role, permission));

export const assertPermission = (role: UserRole, permission: Permission): void => {
  if (!hasPermission(role, permission)) {
    throw new Error(`Role "${role}" lacks permission "${permission}"`);
  }
};
