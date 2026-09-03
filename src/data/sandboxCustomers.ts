export interface SandboxCustomerRecord {
  id: string;
  name: string;
  email: string;
  phone: string;
  properties: number;
  address: string;
  lifetime: string;
  lastService: string;
  nextDue: string;
  status: string;
  tone: 'green' | 'blue' | 'orange' | 'plum';
}

/**
 * Shared, deterministic customer fixtures used by both the customer workspace and
 * global search. Keeping one source prevents the command palette from advertising
 * records that the customer page cannot actually open.
 */
export const sandboxCustomerRecords: readonly SandboxCustomerRecord[] = [
  {
    id: 'riley',
    name: 'Riley Brooks',
    email: 'riley.brooks@example.com',
    phone: '(817) 555-0172',
    properties: 1,
    address: '421 Oak Hollow Way, Southlake',
    lifetime: '$2,348',
    lastService: 'Today',
    nextDue: 'Jan 2027',
    status: 'Active',
    tone: 'green',
  },
  {
    id: 'morgan',
    name: 'Morgan Ellis',
    email: 'morgan.ellis@example.com',
    phone: '(214) 555-0184',
    properties: 1,
    address: '1842 Cedar Ridge Lane, Flower Mound',
    lifetime: '$0',
    lastService: 'New customer',
    nextDue: 'Quote open',
    status: 'Lead',
    tone: 'blue',
  },
  {
    id: 'taylor',
    name: 'Taylor Nguyen',
    email: 'taylor.nguyen@example.com',
    phone: '(972) 555-0142',
    properties: 2,
    address: '611 Stone Creek Drive, Plano',
    lifetime: '$1,284',
    lastService: 'Jul 25',
    nextDue: 'Oct 2026',
    status: 'Active',
    tone: 'orange',
  },
  {
    id: 'cameron',
    name: 'Cameron Lee',
    email: 'cameron.lee@example.com',
    phone: '(469) 555-0124',
    properties: 1,
    address: '72 Meridian Court, Dallas',
    lifetime: '$1,016',
    lastService: 'Jul 18',
    nextDue: 'Invoice past due',
    status: 'Attention',
    tone: 'plum',
  },
  {
    id: 'jamie',
    name: 'Jamie Ortiz',
    email: 'jamie.ortiz@example.com',
    phone: '(214) 555-0191',
    properties: 3,
    address: '1800 Westlake Parkway, Westlake',
    lifetime: '$3,762',
    lastService: 'Jul 14',
    nextDue: 'Jan 2027',
    status: 'Active',
    tone: 'green',
  },
];
