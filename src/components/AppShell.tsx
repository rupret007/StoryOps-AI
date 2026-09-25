import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Activity,
  BadgeDollarSign,
  Bell,
  Bot,
  BriefcaseBusiness,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  ClipboardCheck,
  CloudOff,
  ContactRound,
  FileCheck2,
  Gauge,
  Inbox,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Power,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  Wifi,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@/domain';
import { NavLink, useLocation, useNavigate } from '@/router';
import { useStoryOps } from '@/state/StoryOpsProvider';
import type { AppRole } from '@/state/model';
import { Avatar, Button } from './ui/Primitives';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  permission?: Permission;
  badge?: 'approvals' | 'inbox';
  liveOnly?: boolean;
}

const primaryNav: NavItem[] = [
  { to: '/', label: 'WashOps', icon: LayoutDashboard, permission: 'analytics.read' },
  { to: '/pipeline', label: 'Pipeline', icon: Inbox, permission: 'customers.read', badge: 'inbox' },
  { to: '/customers', label: 'Customers', icon: ContactRound, permission: 'customers.read' },
  { to: '/dispatch', label: 'Dispatch', icon: CalendarDays, permission: 'jobs.read' },
  { to: '/field', label: 'Field mode', icon: BriefcaseBusiness, permission: 'jobs.read' },
  { to: '/finance', label: 'Finance', icon: CircleDollarSign, permission: 'invoices.read' },
  { to: '/showcase', label: 'Showcase', icon: Sparkles, permission: 'analytics.read' },
];

const officeNav: NavItem[] = [
  { to: '/office', label: 'AI office', icon: Bot, permission: 'automations.read' },
  {
    to: '/approvals',
    label: 'Approvals',
    icon: ShieldCheck,
    permission: 'approvals.read',
    badge: 'approvals',
  },
  { to: '/operations', label: 'Operations', icon: ClipboardCheck, permission: 'catalog.read' },
  {
    to: '/setup',
    label: 'Company setup',
    icon: Gauge,
    permission: 'company.manage',
  },
  {
    to: '/company-control',
    label: 'Company control',
    icon: Power,
    permission: 'company.manage',
    liveOnly: true,
  },
  {
    to: '/integrations',
    label: 'Integrations',
    icon: Settings2,
    permission: 'company.manage',
  },
  {
    to: '/access',
    label: 'Team & portal access',
    icon: KeyRound,
    permission: 'members.manage',
    liveOnly: true,
  },
  { to: '/audit', label: 'Audit trail', icon: Activity, permission: 'ai_traces.read' },
];

const mobileQuickNav: NavItem[] = [
  { to: '/', label: 'Home', icon: Gauge, permission: 'analytics.read' },
  { to: '/pipeline', label: 'Pipeline', icon: Inbox, permission: 'customers.read' },
  { to: '/field', label: 'Field', icon: BriefcaseBusiness, permission: 'jobs.read' },
  { to: '/approvals', label: 'Approve', icon: ShieldCheck, permission: 'approvals.read' },
  { to: '/portal', label: 'Portal', icon: UserRound, permission: 'portal.self.read' },
];

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const sandboxSearchItems = (estimateTotal: string) => [
  {
    title: 'Morgan Ellis',
    meta: 'Customer · Flower Mound',
    href: '/pipeline?lead=lead-morgan',
    icon: UserRound,
  },
  {
    title: 'EST-1048',
    meta: `Estimate · ${new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(Number(estimateTotal))}`,
    href: '/estimates/estimate-1048',
    icon: FileCheck2,
  },
  {
    title: 'JOB-1032',
    meta: 'Today · Riley Brooks',
    href: '/field',
    icon: BriefcaseBusiness,
  },
  {
    title: 'INV-1021',
    meta: 'Past due · $438.70',
    href: '/finance',
    icon: BadgeDollarSign,
  },
  {
    title: 'DFW Residential 2026.07',
    meta: 'Active price book · v3',
    href: '/operations',
    icon: Settings2,
  },
];

const roleLabels: Record<AppRole, string> = {
  owner: 'Owner',
  dispatcher: 'Dispatcher',
  technician: 'Technician',
  customer: 'Customer',
};

function useDialogKeyboard(
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusableElements = () =>
      Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (element) => element.getAttribute('aria-hidden') !== 'true',
      );

    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    (initialFocusRef?.current ?? focusableElements()[0] ?? dialog).focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const elements = focusableElements();
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = elements[0];
      const last = elements.at(-1);
      if (!first || !last) return;
      const activeElement = document.activeElement;

      if (event.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeElement === last || !dialog.contains(activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [dialogRef, initialFocusRef, onClose]);
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand__mark">
        <Sparkles size={18} strokeWidth={2.4} aria-hidden="true" />
      </span>
      <span className="brand__name">
        WashOps
        <span className="brand__edition">Exterior services</span>
      </span>
    </div>
  );
}

function Sidebar() {
  const { state, can } = useStoryOps();
  const pendingApprovals = state.approvals.filter((item) => item.status === 'pending').length;
  const newLeads = state.leads.filter((lead) => lead.stage === 'new').length;
  const sandboxOwner = state.setupProfile?.ownerName ?? 'Jeff Story';
  const companyName = state.live?.companyName ?? state.setupProfile?.businessName ?? 'WashOps';

  const renderNav = (items: NavItem[]) => (
    <ul className="nav-list">
      {items
        .filter(
          (item) =>
            (!item.permission || can(item.permission)) &&
            (!item.liveOnly || state.dataMode === 'supabase'),
        )
        .map(({ to, label, icon: Icon, badge }) => (
          <li key={to}>
            <NavLink className="nav-link" to={to} end={to === '/'}>
              <Icon size={17} strokeWidth={1.9} aria-hidden="true" />
              <span>{label}</span>
              {badge === 'approvals' && pendingApprovals > 0 && (
                <span className="nav-link__badge">{pendingApprovals}</span>
              )}
              {badge === 'inbox' && newLeads > 0 && (
                <span className="nav-link__badge">{newLeads}</span>
              )}
            </NavLink>
          </li>
        ))}
    </ul>
  );

  return (
    <aside className="sidebar" aria-label="Primary navigation">
      <Brand />
      <nav>
        <section className="nav-section">
          <p className="nav-section__label">Workspace</p>
          {renderNav(primaryNav)}
        </section>
        <section className="nav-section">
          <p className="nav-section__label">Back office</p>
          {renderNav(officeNav)}
        </section>
      </nav>
      <div className="sidebar__footer">
        <div className="ai-status-card">
          <div className="ai-status-card__top">
            <span className="pulse-dot" aria-hidden="true" />
            {state.dataMode === 'supabase'
              ? !state.online
                ? 'Authenticated workspace offline'
                : state.serverVerifiedAt
                  ? 'Authenticated server verified'
                  : 'Network available · server not verified'
              : 'AI office ready · manual runs'}
          </div>
          <p>
            {state.dataMode === 'supabase'
              ? `Authenticated role-scoped workspace · ${state.integrations.length} provider records`
              : '8 specialists · policy v1.0 · sandbox adapters ready'}
          </p>
        </div>
        <div className="workspace-switcher">
          <Avatar
            name={state.dataMode === 'supabase' ? roleLabels[state.role] : sandboxOwner}
            size="sm"
          />
          <div>
            <div className="workspace-switcher__name">{companyName}</div>
            <div className="workspace-switcher__role">
              {roleLabels[state.role]} {state.dataMode === 'supabase' ? 'membership' : 'view'}
            </div>
          </div>
          <ChevronDown size={14} aria-hidden="true" />
        </div>
      </div>
    </aside>
  );
}

function Topbar({
  onSearch,
  onNotifications,
  notificationsOpen,
  searchButtonRef,
}: {
  onSearch(returnTarget?: HTMLElement): void;
  onNotifications(): void;
  notificationsOpen: boolean;
  searchButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const { state, actions } = useStoryOps();
  const navigate = useNavigate();
  const location = useLocation();
  const unread = state.notifications.filter((notification) => !notification.read).length;
  const workspaceDate =
    state.dataMode === 'supabase' && state.live?.serverTime
      ? new Date(state.live.serverTime)
      : undefined;
  const queuedChanges = state.offlineQueue.filter(
    (item) => item.status === 'queued' || item.status === 'syncing',
  ).length;
  const failedChanges = state.offlineQueue.filter((item) => item.status === 'failed').length;
  const queueSummary = `${queuedChanges} queued · ${failedChanges} failed`;
  const connectivityLabel =
    state.dataMode === 'sandbox'
      ? state.online
        ? 'Local sandbox · network available'
        : 'Local sandbox · browser offline'
      : !state.online
        ? `Browser offline · ${queueSummary}`
        : !state.serverVerifiedAt
          ? `Network available · server not verified · ${queueSummary}`
          : `Server verified · ${queueSummary}`;
  const connectivityTitle =
    state.dataMode === 'sandbox'
      ? 'Local fixtures are stored on this device; browser network availability does not verify a server.'
      : state.serverVerifiedAt
        ? `The authenticated server was last verified at ${state.serverVerifiedAt}.`
        : state.online
          ? 'The browser network is available, but WashOps has not verified the authenticated server.'
          : 'The browser reports no network connection.';

  const changeRole = (role: AppRole) => {
    actions.setRole(role);
    if (role === 'customer') {
      navigate('/portal');
    } else if (location.pathname === '/portal') {
      navigate('/');
    }
  };

  const restartSandboxRehearsal = () => {
    if (
      window.confirm(
        'Restart the local sandbox rehearsal? This clears the local profile and every synthetic fixture on this device. No provider, customer, or payment record is affected.',
      )
    ) {
      actions.resetDemo();
      navigate('/setup');
    }
  };
  const showcaseBadge = actions.getShowcaseBadge();

  return (
    <header className="topbar">
      <div className="topbar__date">
        <strong>
          {workspaceDate
            ? new Intl.DateTimeFormat('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                timeZone: state.live?.companyTimezone,
              }).format(workspaceDate)
            : 'Sandbox scenario · Tuesday, July 28'}
        </strong>
        {workspaceDate
          ? `${state.live?.companyTimezone} · ${new Intl.DateTimeFormat('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              timeZone: state.live?.companyTimezone,
            }).format(workspaceDate)}`
          : 'DFW fixture · 9:28 AM'}
      </div>
      <button
        ref={searchButtonRef}
        className="command-trigger"
        type="button"
        aria-label="Search WashOps"
        aria-haspopup="dialog"
        onClick={(event) => onSearch(event.currentTarget)}
      >
        <Search size={16} aria-hidden="true" />
        <span className="command-trigger__hint">Search customers, jobs, invoices…</span>
        <kbd>⌘ K</kbd>
      </button>
      <div className="topbar__actions">
        <span
          className={`offline-indicator ${
            !state.online ||
            (state.dataMode === 'supabase' &&
              (!state.serverVerifiedAt || queuedChanges > 0 || failedChanges > 0))
              ? 'offline-indicator--offline'
              : ''
          }`}
          aria-label={connectivityLabel}
          title={connectivityTitle}
        >
          {state.online ? <Wifi size={13} /> : <CloudOff size={13} />}
          <span>{connectivityLabel}</span>
        </span>
        {state.dataMode === 'sandbox' ? (
          <>
            <button
              className="button button--secondary button--sm topbar__sandbox-restart"
              type="button"
              onClick={restartSandboxRehearsal}
            >
              Restart rehearsal
            </button>
            <button
              className="button button--dark button--sm topbar__showcase-reset"
              type="button"
              title={showcaseBadge.ownerNotice}
              onClick={() => actions.resetShowcaseData()}
            >
              Reset Showcase Data
            </button>
            <span className="topbar__showcase-badge" title={showcaseBadge.ownerNotice}>
              {showcaseBadge.label} · {showcaseBadge.scope}
            </span>
            <label className="sr-only" htmlFor="role-switcher">
              Preview role
            </label>
            <select
              id="role-switcher"
              className="role-switcher topbar__role-switcher"
              value={state.role}
              onChange={(event) => changeRole(event.target.value as AppRole)}
              aria-label="Preview role"
            >
              <option value="owner">Owner</option>
              <option value="dispatcher">Dispatcher</option>
              <option value="technician">Technician</option>
              <option value="customer">Customer</option>
            </select>
          </>
        ) : (
          <>
            <span
              className="role-switcher topbar__role-switcher"
              aria-label={`Server role: ${roleLabels[state.role]}`}
            >
              {roleLabels[state.role]}
            </span>
            <button
              className="icon-button topbar__sign-out"
              type="button"
              aria-label="Sign out"
              title={
                state.offlineQueue.length > 0
                  ? 'Sync queued field changes before signing out'
                  : 'Sign out'
              }
              onClick={() => void actions.signOut()}
            >
              <LogOut size={16} />
            </button>
            <button
              className="icon-button topbar__clear-device"
              type="button"
              aria-label="Clear synced WashOps data from this device"
              title="Clear this device and sign out"
              onClick={() => void actions.clearThisDevice()}
            >
              <Trash2 size={16} />
            </button>
          </>
        )}
        <button
          className="icon-button"
          type="button"
          aria-label="Notifications"
          aria-expanded={notificationsOpen}
          onClick={onNotifications}
        >
          <Bell size={17} aria-hidden="true" />
          {unread > 0 && <span className="icon-button__dot" aria-hidden="true" />}
        </button>
      </div>
    </header>
  );
}

function MobileNav({
  menuOpen,
  menuButtonRef,
  onMenuOpen,
}: {
  menuOpen: boolean;
  menuButtonRef: RefObject<HTMLButtonElement | null>;
  onMenuOpen(): void;
}) {
  const { can } = useStoryOps();

  return (
    <nav className="mobile-nav" aria-label="Mobile navigation">
      {mobileQuickNav
        .filter(({ permission }) => !permission || can(permission))
        .slice(0, 4)
        .map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} end={to === '/'}>
            <Icon size={18} aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        ))}
      <button
        ref={menuButtonRef}
        type="button"
        aria-label="Open navigation menu"
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        aria-controls="mobile-navigation-menu"
        onClick={onMenuOpen}
      >
        <Menu size={18} aria-hidden="true" />
        <span>Menu</span>
      </button>
    </nav>
  );
}

function MobileMenu({ onClose }: { onClose(): void }) {
  const { state, actions, can } = useStoryOps();
  const navigate = useNavigate();
  const location = useLocation();
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const pendingApprovals = state.approvals.filter((item) => item.status === 'pending').length;
  const newLeads = state.leads.filter((lead) => lead.stage === 'new').length;
  const companyName = state.live?.companyName ?? state.setupProfile?.businessName ?? 'WashOps';

  useDialogKeyboard(dialogRef, onClose, closeButtonRef);

  const changeRole = (role: AppRole) => {
    actions.setRole(role);
    onClose();
    if (role === 'customer') {
      navigate('/portal');
    } else if (location.pathname === '/portal') {
      navigate('/');
    }
  };

  const restartSandboxRehearsal = () => {
    if (
      window.confirm(
        'Restart the local sandbox rehearsal? This clears the local profile and every synthetic fixture on this device. No provider, customer, or payment record is affected.',
      )
    ) {
      actions.resetDemo();
      onClose();
      navigate('/setup');
    }
  };
  const showcaseBadge = actions.getShowcaseBadge();

  const renderNav = (items: NavItem[]) => (
    <ul className="mobile-menu__links">
      {items
        .filter(
          (item) =>
            (!item.permission || can(item.permission)) &&
            (!item.liveOnly || state.dataMode === 'supabase'),
        )
        .map(({ to, label, icon: Icon, badge }) => (
          <li key={to}>
            <NavLink to={to} end={to === '/'} onClick={onClose}>
              <Icon size={18} strokeWidth={1.9} aria-hidden="true" />
              <span>{label}</span>
              {badge === 'approvals' && pendingApprovals > 0 && (
                <span className="nav-link__badge" aria-label={`${pendingApprovals} pending`}>
                  {pendingApprovals}
                </span>
              )}
              {badge === 'inbox' && newLeads > 0 && (
                <span className="nav-link__badge" aria-label={`${newLeads} new`}>
                  {newLeads}
                </span>
              )}
            </NavLink>
          </li>
        ))}
    </ul>
  );

  const currentRecordNav: NavItem[] = [
    ...(can('portal.self.read')
      ? [{ to: '/portal', label: 'Customer portal', icon: UserRound } satisfies NavItem]
      : []),
    ...(state.estimate.id && can('estimates.read')
      ? [
          {
            to: `/estimates/${encodeURIComponent(state.estimate.id)}`,
            label: `Estimate ${state.estimate.estimateNumber}`,
            icon: FileCheck2,
          } satisfies NavItem,
        ]
      : []),
  ];

  return (
    <div className="mobile-menu-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        id="mobile-navigation-menu"
        className="mobile-menu"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-navigation-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="mobile-menu__header">
          <div>
            <p className="eyebrow">Navigation</p>
            <h2 id="mobile-navigation-title">WashOps workspace</h2>
          </div>
          <button
            ref={closeButtonRef}
            className="icon-button"
            type="button"
            aria-label="Close navigation menu"
            onClick={onClose}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <div className="mobile-menu__workspace">
          <Avatar name={roleLabels[state.role]} size="sm" />
          <span>
            <strong>{companyName}</strong>
            <small>
              {state.dataMode === 'supabase'
                ? `${roleLabels[state.role]} authenticated membership`
                : `${roleLabels[state.role]} sandbox preview`}
            </small>
          </span>
        </div>

        <nav aria-label="All available destinations">
          <section className="mobile-menu__section">
            <h3>Workspace</h3>
            {renderNav(primaryNav)}
          </section>
          <section className="mobile-menu__section">
            <h3>Back office</h3>
            {renderNav(officeNav)}
          </section>
          {currentRecordNav.length > 0 && (
            <section className="mobile-menu__section">
              <h3>Current records</h3>
              {renderNav(currentRecordNav)}
            </section>
          )}
        </nav>

        <footer className="mobile-menu__footer">
          {state.dataMode === 'sandbox' ? (
            <>
              <p>
                Role preview changes only this local synthetic rehearsal. It does not grant a server
                role or contact a customer.
              </p>
              <label htmlFor="mobile-role-switcher">Preview role</label>
              <select
                id="mobile-role-switcher"
                className="role-switcher"
                value={state.role}
                onChange={(event) => changeRole(event.target.value as AppRole)}
              >
                <option value="owner">Owner</option>
                <option value="dispatcher">Dispatcher</option>
                <option value="technician">Technician</option>
                <option value="customer">Customer</option>
              </select>
              <p className="mobile-menu__badge">
                {showcaseBadge.label} · {showcaseBadge.scope}
              </p>
              <Button variant="secondary" size="sm" onClick={restartSandboxRehearsal}>
                Restart local sandbox rehearsal
              </Button>
              <Button variant="secondary" size="sm" onClick={() => actions.resetShowcaseData()}>
                Reset showcase data
              </Button>
            </>
          ) : (
            <>
              <p>
                Signed in with the {roleLabels[state.role]} membership. Signing out does not clear
                queued field data from this device.
              </p>
              <Button
                variant="secondary"
                size="sm"
                icon={<LogOut size={16} aria-hidden="true" />}
                onClick={() => {
                  onClose();
                  void actions.signOut();
                }}
              >
                Sign out of WashOps
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={<Trash2 size={16} aria-hidden="true" />}
                onClick={() => {
                  onClose();
                  void actions.clearThisDevice();
                }}
              >
                Clear this device and sign out
              </Button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

function CommandPalette({ onClose }: { onClose(): void }) {
  const [query, setQuery] = useState('');
  const { state } = useStoryOps();
  const navigate = useNavigate();
  const dialogRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const items = useMemo(() => {
    if (state.dataMode === 'sandbox') return sandboxSearchItems(state.estimate.total);
    return [
      ...(state.live?.customers ?? []).map((customer) => ({
        title: customer.name,
        meta: `Customer · ${customer.address}`,
        href: '/customers',
        icon: UserRound,
      })),
      ...state.leads.map((lead) => ({
        title: lead.name,
        meta: `Lead · ${lead.service}`,
        href: `/pipeline?lead=${encodeURIComponent(lead.id)}`,
        icon: Inbox,
      })),
      ...state.visits.map((visit) => ({
        title: visit.jobNumber,
        meta: `Visit · ${visit.customerName} · ${visit.status.replaceAll('_', ' ')}`,
        href: '/field',
        icon: BriefcaseBusiness,
      })),
      ...state.invoices.map((invoice) => ({
        title: invoice.number,
        meta: `Invoice · ${invoice.customerName} · ${invoice.status}`,
        href: '/finance',
        icon: BadgeDollarSign,
      })),
      ...(state.estimate.id
        ? [
            {
              title: state.estimate.estimateNumber,
              meta: `Estimate · ${state.estimate.status}`,
              href: `/estimates/${encodeURIComponent(state.estimate.id)}`,
              icon: FileCheck2,
            },
          ]
        : []),
    ];
  }, [state]);
  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? items.filter(
          (item) =>
            item.title.toLowerCase().includes(normalized) ||
            item.meta.toLowerCase().includes(normalized),
        )
      : items;
  }, [items, query]);

  useDialogKeyboard(dialogRef, onClose, searchInputRef);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="command-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Search WashOps"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-modal__input">
          <Search size={18} aria-hidden="true" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search customers, jobs, estimates, invoices…"
            aria-label="Search"
          />
          <button className="icon-button" type="button" aria-label="Close search" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="command-results">
          {results.map(({ title, meta, href, icon: Icon }) => (
            <button
              className="command-result"
              type="button"
              key={title}
              onClick={() => {
                navigate(href);
                onClose();
              }}
            >
              <span className="command-result__icon">
                <Icon size={15} aria-hidden="true" />
              </span>
              <span>
                <span className="command-result__title">{title}</span>
                <span className="command-result__meta">{meta}</span>
              </span>
            </button>
          ))}
          {results.length === 0 && (
            <div className="empty-state">
              <Search size={20} />
              <h3>No matches</h3>
              <p>Try a customer, job, estimate, or invoice number.</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function NotificationPanel({ onClose }: { onClose(): void }) {
  const { state, actions } = useStoryOps();
  const navigate = useNavigate();
  return (
    <div className="notification-popover" role="dialog" aria-label="Notifications">
      <div className="notification-popover__header">
        <div>
          <h2>Notifications</h2>
          <p>{state.notifications.filter((item) => !item.read).length} unread</p>
        </div>
        <Button variant="ghost" size="sm" onClick={actions.markNotificationsRead}>
          Mark read
        </Button>
      </div>
      <div className="notification-popover__list">
        {state.notifications.map((notification) => (
          <button
            type="button"
            key={notification.id}
            className={`notification-item ${notification.read ? '' : 'notification-item--unread'}`}
            onClick={() => {
              navigate(notification.href);
              onClose();
            }}
          >
            <span className="notification-item__icon">
              {notification.href === '/approvals' ? (
                <ShieldCheck size={15} />
              ) : notification.href === '/finance' ? (
                <CircleDollarSign size={15} />
              ) : (
                <CalendarDays size={15} />
              )}
            </span>
            <span>
              <strong>{notification.title}</strong>
              <small>{notification.body}</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ToastRegion() {
  const { state, actions } = useStoryOps();

  useEffect(() => {
    const timers = state.toasts.map((toast) =>
      window.setTimeout(() => actions.dismissToast(toast.id), 5200),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [actions, state.toasts]);

  return (
    <div className="toast-region" role="status" aria-live="polite" aria-atomic="false">
      {state.toasts.map((toast) => (
        <div className="toast" key={toast.id}>
          <CheckCircle2 className="toast__icon" size={18} aria-hidden="true" />
          <div>
            <p className="toast__title">{toast.title}</p>
            <p className="toast__detail">{toast.detail}</p>
          </div>
          <button
            className="button button--ghost button--sm"
            type="button"
            aria-label={`Dismiss ${toast.title}`}
            onClick={() => actions.dismissToast(toast.id)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notificationsPath, setNotificationsPath] = useState('/');
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const searchReturnFocusRef = useRef<HTMLElement | null>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileMenuReturnFocusRef = useRef<HTMLElement | null>(null);
  const location = useLocation();
  const showNotifications = notificationsOpen && notificationsPath === location.pathname;
  const modalOpen = searchOpen || mobileMenuOpen;

  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const openSearch = useCallback((returnTarget?: HTMLElement) => {
    searchReturnFocusRef.current =
      returnTarget ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : searchButtonRef.current);
    setMobileMenuOpen(false);
    setNotificationsOpen(false);
    setSearchOpen(true);
  }, []);

  const closeMobileMenu = useCallback(() => setMobileMenuOpen(false), []);
  const openMobileMenu = useCallback(() => {
    mobileMenuReturnFocusRef.current = mobileMenuButtonRef.current;
    setSearchOpen(false);
    setNotificationsOpen(false);
    setMobileMenuOpen(true);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openSearch]);

  useEffect(() => {
    if (searchOpen || !searchReturnFocusRef.current) return;
    const returnTarget = searchReturnFocusRef.current;
    searchReturnFocusRef.current = null;
    const timer = window.setTimeout(() => {
      if (returnTarget.isConnected) returnTarget.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [searchOpen]);

  useEffect(() => {
    if (mobileMenuOpen || !mobileMenuReturnFocusRef.current) return;
    const returnTarget = mobileMenuReturnFocusRef.current;
    mobileMenuReturnFocusRef.current = null;
    const timer = window.setTimeout(() => {
      if (returnTarget.isConnected) returnTarget.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [mobileMenuOpen]);

  return (
    <div className="app app-shell">
      <div
        className="app-shell__chrome"
        inert={modalOpen}
        aria-hidden={modalOpen ? true : undefined}
      >
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <Sidebar />
        <div className="main-column">
          <Topbar
            onSearch={openSearch}
            onNotifications={() => {
              setNotificationsPath(location.pathname);
              setNotificationsOpen((open) =>
                notificationsPath === location.pathname ? !open : true,
              );
            }}
            notificationsOpen={showNotifications}
            searchButtonRef={searchButtonRef}
          />
          {showNotifications && <NotificationPanel onClose={() => setNotificationsOpen(false)} />}
          <main id="main-content">{children}</main>
        </div>
        <MobileNav
          menuOpen={mobileMenuOpen}
          menuButtonRef={mobileMenuButtonRef}
          onMenuOpen={openMobileMenu}
        />
        <ToastRegion />
      </div>
      {mobileMenuOpen && <MobileMenu onClose={closeMobileMenu} />}
      {searchOpen && <CommandPalette onClose={closeSearch} />}
    </div>
  );
}
