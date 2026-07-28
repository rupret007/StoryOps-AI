import { type ReactNode, useEffect, useMemo, useState } from 'react';
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
  LayoutDashboard,
  LogOut,
  Menu,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
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
}

const primaryNav: NavItem[] = [
  { to: '/', label: 'Command center', icon: LayoutDashboard, permission: 'analytics.read' },
  { to: '/pipeline', label: 'Pipeline', icon: Inbox, permission: 'customers.read', badge: 'inbox' },
  { to: '/customers', label: 'Customers', icon: ContactRound, permission: 'customers.read' },
  { to: '/dispatch', label: 'Dispatch', icon: CalendarDays, permission: 'jobs.read' },
  { to: '/field', label: 'Field mode', icon: BriefcaseBusiness, permission: 'jobs.read' },
  { to: '/finance', label: 'Finance', icon: CircleDollarSign, permission: 'invoices.read' },
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
    to: '/integrations',
    label: 'Integrations',
    icon: Settings2,
    permission: 'company.manage',
  },
  { to: '/audit', label: 'Audit trail', icon: Activity, permission: 'ai_traces.read' },
];

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

function Brand() {
  return (
    <div className="brand">
      <span className="brand__mark">
        <Sparkles size={18} strokeWidth={2.4} aria-hidden="true" />
      </span>
      <span className="brand__name">
        StoryOps AI
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
  const companyName = state.live?.companyName ?? state.setupProfile?.businessName ?? 'StoryOps';

  const renderNav = (items: NavItem[]) => (
    <ul className="nav-list">
      {items
        .filter((item) => !item.permission || can(item.permission))
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
            {state.dataMode === 'supabase' ? 'Live workspace connected' : 'AI office on duty'}
          </div>
          <p>
            {state.dataMode === 'supabase'
              ? `Live role-scoped workspace · ${state.integrations.length} provider records`
              : '8 agents · policy v1.0 · sandbox providers healthy'}
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
}: {
  onSearch(): void;
  onNotifications(): void;
  notificationsOpen: boolean;
}) {
  const { state, actions } = useStoryOps();
  const navigate = useNavigate();
  const location = useLocation();
  const unread = state.notifications.filter((notification) => !notification.read).length;
  const workspaceDate =
    state.dataMode === 'supabase' && state.live?.serverTime
      ? new Date(state.live.serverTime)
      : undefined;

  const changeRole = (role: AppRole) => {
    actions.setRole(role);
    if (role === 'customer') {
      navigate('/portal');
    } else if (location.pathname === '/portal') {
      navigate('/');
    }
  };

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
            : 'Tuesday, July 28'}
        </strong>
        {workspaceDate
          ? `${state.live?.companyTimezone} · ${new Intl.DateTimeFormat('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              timeZone: state.live?.companyTimezone,
            }).format(workspaceDate)}`
          : 'DFW · 9:28 AM'}
      </div>
      <button className="command-trigger" type="button" onClick={onSearch}>
        <Search size={16} aria-hidden="true" />
        <span className="command-trigger__hint">Search customers, jobs, invoices…</span>
        <kbd>⌘ K</kbd>
      </button>
      <div className="topbar__actions">
        <span
          className={`offline-indicator ${state.online ? '' : 'offline-indicator--offline'}`}
          title={
            state.online
              ? state.dataMode === 'supabase'
                ? 'Connected to the authenticated Supabase repository'
                : 'Connected to the sandbox repository'
              : 'Changes are queued on this device'
          }
        >
          {state.online ? <Wifi size={13} /> : <CloudOff size={13} />}
          <span>{state.online ? 'Synced' : `Offline · ${state.offlineQueue.length} queued`}</span>
        </span>
        {state.dataMode === 'sandbox' ? (
          <>
            <label className="sr-only" htmlFor="role-switcher">
              Preview role
            </label>
            <select
              id="role-switcher"
              className="role-switcher"
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
            <span className="role-switcher" aria-label={`Server role: ${roleLabels[state.role]}`}>
              {roleLabels[state.role]}
            </span>
            <button
              className="icon-button"
              type="button"
              aria-label="Sign out"
              title="Sign out"
              onClick={() => void actions.signOut()}
            >
              <LogOut size={16} />
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

function MobileNav() {
  const { can } = useStoryOps();
  const items = [
    { to: '/', label: 'Home', icon: Gauge, permission: 'analytics.read' as Permission },
    { to: '/pipeline', label: 'Pipeline', icon: Inbox, permission: 'customers.read' as Permission },
    {
      to: '/field',
      label: 'Field',
      icon: BriefcaseBusiness,
      permission: 'jobs.read' as Permission,
    },
    {
      to: '/approvals',
      label: 'Approve',
      icon: ShieldCheck,
      permission: 'approvals.read' as Permission,
    },
    {
      to: '/operations',
      label: 'More',
      icon: Menu,
      permission: 'catalog.read' as Permission,
    },
  ];

  return (
    <nav className="mobile-nav" aria-label="Mobile navigation">
      {items
        .filter(({ permission }) => can(permission))
        .map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} end={to === '/'}>
            <Icon size={18} aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        ))}
    </nav>
  );
}

function CommandPalette({ onClose }: { onClose(): void }) {
  const [query, setQuery] = useState('');
  const { state } = useStoryOps();
  const navigate = useNavigate();
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

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="command-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Search StoryOps"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-modal__input">
          <Search size={18} aria-hidden="true" />
          <input
            autoFocus
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
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notificationsPath, setNotificationsPath] = useState('/');
  const location = useLocation();
  const showNotifications = notificationsOpen && notificationsPath === location.pathname;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="app app-shell">
      <Sidebar />
      <div className="main-column">
        <Topbar
          onSearch={() => setSearchOpen(true)}
          onNotifications={() => {
            setNotificationsPath(location.pathname);
            setNotificationsOpen((open) =>
              notificationsPath === location.pathname ? !open : true,
            );
          }}
          notificationsOpen={showNotifications}
        />
        {showNotifications && <NotificationPanel onClose={() => setNotificationsOpen(false)} />}
        <main id="main-content">{children}</main>
      </div>
      <MobileNav />
      <ToastRegion />
      {searchOpen && <CommandPalette onClose={() => setSearchOpen(false)} />}
    </div>
  );
}
