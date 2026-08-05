import { lazy, Suspense, type ReactNode } from 'react';
import type { Permission } from '@/domain';
import { AppShell } from '@/components/AppShell';
import { Navigate, useLocation } from '@/router';
import { useStoryOps } from '@/state/StoryOpsProvider';
import { AccessDeniedPage } from '@/pages/AccessDeniedPage';
import { NotFoundPage } from '@/pages/NotFoundPage';

const AiOfficePage = lazy(async () => ({
  default: (await import('@/pages/AiOfficePage')).AiOfficePage,
}));
const ApprovalsPage = lazy(async () => ({
  default: (await import('@/pages/ApprovalsPage')).ApprovalsPage,
}));
const AuditPage = lazy(async () => ({
  default: (await import('@/pages/AuditPage')).AuditPage,
}));
const CompanyControlPage = lazy(async () => ({
  default: (await import('@/pages/CompanyControlPage')).CompanyControlPage,
}));
const CustomersPage = lazy(async () => ({
  default: (await import('@/pages/CustomersPage')).CustomersPage,
}));
const DashboardPage = lazy(async () => ({
  default: (await import('@/pages/DashboardPage')).DashboardPage,
}));
const DispatchPage = lazy(async () => ({
  default: (await import('@/pages/DispatchPage')).DispatchPage,
}));
const EstimatePage = lazy(async () => ({
  default: (await import('@/pages/EstimatePage')).EstimatePage,
}));
const FieldPage = lazy(async () => ({
  default: (await import('@/pages/FieldPage')).FieldPage,
}));
const FinancePage = lazy(async () => ({
  default: (await import('@/pages/FinancePage')).FinancePage,
}));
const IdentityProvisioningPage = lazy(async () => ({
  default: (await import('@/pages/IdentityProvisioningPage')).IdentityProvisioningPage,
}));
const IntegrationsPage = lazy(async () => ({
  default: (await import('@/pages/IntegrationsPage')).IntegrationsPage,
}));
const LiveSignInPage = lazy(async () => ({
  default: (await import('@/pages/LiveSignInPage')).LiveSignInPage,
}));
const OperationsPage = lazy(async () => ({
  default: (await import('@/pages/OperationsPage')).OperationsPage,
}));
const PipelinePage = lazy(async () => ({
  default: (await import('@/pages/PipelinePage')).PipelinePage,
}));
const PortalPage = lazy(async () => ({
  default: (await import('@/pages/PortalPage')).PortalPage,
}));
const SetupPage = lazy(async () => ({
  default: (await import('@/pages/SetupPage')).SetupPage,
}));
const ShowcasePage = lazy(async () => ({
  default: (await import('@/pages/ShowcasePage')).ShowcasePage,
}));

function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}) {
  const { can } = useStoryOps();
  return can(permission) ? children : <AccessDeniedPage permission={permission} />;
}

function HomeRoute() {
  const { state, can } = useStoryOps();
  if (state.role === 'customer') return <Navigate to="/portal" replace />;
  if (state.role === 'technician' && !can('analytics.read')) {
    return <Navigate to="/field" replace />;
  }
  return <DashboardPage />;
}

function AppRoutes() {
  const { state, can } = useStoryOps();
  const location = useLocation();

  if (state.dataMode === 'supabase' && state.authStatus !== 'signed_in') {
    return <LiveSignInPage />;
  }

  if (state.companyControlRecovery) {
    return <CompanyControlPage />;
  }

  if (state.hydrated && !state.setupComplete && location.pathname !== '/setup') {
    return <Navigate to="/setup" replace />;
  }

  if (location.pathname === '/setup') {
    if (state.setupComplete && !can('company.manage')) {
      return (
        <AppShell>
          <AccessDeniedPage permission="company.manage" />
        </AppShell>
      );
    }
    return <SetupPage />;
  }
  if (location.pathname === '/portal') return <PortalPage />;

  let page: ReactNode;
  switch (location.pathname) {
    case '/':
      page = <HomeRoute />;
      break;
    case '/pipeline':
      page = (
        <RequirePermission permission="customers.read">
          <PipelinePage />
        </RequirePermission>
      );
      break;
    case '/customers':
      page = (
        <RequirePermission permission="customers.read">
          <CustomersPage />
        </RequirePermission>
      );
      break;
    case '/dispatch':
      page = (
        <RequirePermission permission="jobs.read">
          <DispatchPage />
        </RequirePermission>
      );
      break;
    case '/field':
      page = (
        <RequirePermission permission="jobs.read">
          <FieldPage />
        </RequirePermission>
      );
      break;
    case '/finance':
      page = (
        <RequirePermission permission="invoices.read">
          <FinancePage />
        </RequirePermission>
      );
      break;
    case '/showcase':
      page = (
        <RequirePermission permission="analytics.read">
          <ShowcasePage />
        </RequirePermission>
      );
      break;
    case '/office':
      page = (
        <RequirePermission permission="automations.read">
          <AiOfficePage />
        </RequirePermission>
      );
      break;
    case '/approvals':
      page = (
        <RequirePermission permission="approvals.read">
          <ApprovalsPage />
        </RequirePermission>
      );
      break;
    case '/operations':
      page = (
        <RequirePermission permission="catalog.read">
          <OperationsPage />
        </RequirePermission>
      );
      break;
    case '/integrations':
      page = (
        <RequirePermission permission="company.manage">
          <IntegrationsPage />
        </RequirePermission>
      );
      break;
    case '/access':
      page = (
        <RequirePermission permission="members.manage">
          <IdentityProvisioningPage />
        </RequirePermission>
      );
      break;
    case '/company-control':
      page = (
        <RequirePermission permission="company.manage">
          <CompanyControlPage />
        </RequirePermission>
      );
      break;
    case '/audit':
      page = (
        <RequirePermission permission="ai_traces.read">
          <AuditPage />
        </RequirePermission>
      );
      break;
    default:
      page = location.pathname.startsWith('/estimates/') ? (
        <RequirePermission permission="estimates.read">
          <EstimatePage />
        </RequirePermission>
      ) : (
        <NotFoundPage />
      );
  }

  return <AppShell>{page}</AppShell>;
}

export function App() {
  return (
    <Suspense
      fallback={
        <main className="route-loading" aria-live="polite" aria-busy="true">
          Loading workspace…
        </main>
      }
    >
      <AppRoutes />
    </Suspense>
  );
}
