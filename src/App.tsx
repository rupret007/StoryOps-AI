import type { ReactNode } from 'react';
import type { Permission } from '@/domain';
import { AppShell } from '@/components/AppShell';
import { Navigate, useLocation } from '@/router';
import { useStoryOps } from '@/state/StoryOpsProvider';
import { AccessDeniedPage } from '@/pages/AccessDeniedPage';
import { AiOfficePage } from '@/pages/AiOfficePage';
import { ApprovalsPage } from '@/pages/ApprovalsPage';
import { AuditPage } from '@/pages/AuditPage';
import { CustomersPage } from '@/pages/CustomersPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { DispatchPage } from '@/pages/DispatchPage';
import { EstimatePage } from '@/pages/EstimatePage';
import { FieldPage } from '@/pages/FieldPage';
import { FinancePage } from '@/pages/FinancePage';
import { IntegrationsPage } from '@/pages/IntegrationsPage';
import { LiveSignInPage } from '@/pages/LiveSignInPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { OperationsPage } from '@/pages/OperationsPage';
import { PipelinePage } from '@/pages/PipelinePage';
import { PortalPage } from '@/pages/PortalPage';
import { SetupPage } from '@/pages/SetupPage';

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

export function App() {
  const { state } = useStoryOps();
  const location = useLocation();

  if (state.dataMode === 'supabase' && state.authStatus !== 'signed_in') {
    return <LiveSignInPage />;
  }

  if (state.hydrated && !state.setupComplete && location.pathname !== '/setup') {
    return <Navigate to="/setup" replace />;
  }

  if (location.pathname === '/setup') {
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
