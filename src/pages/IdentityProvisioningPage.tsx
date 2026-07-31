import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { IdentityProvisioningPanel } from '@/components/IdentityProvisioningPanel';
import { Button, Card, PageHeader, Skeleton } from '@/components/ui/Primitives';
import type {
  IdentityProvisioningInput,
  IdentityProvisioningReceipt,
  IdentityProvisioningState,
} from '@/core/identity/provisioning';
import { getLiveStoryOpsRepository } from '@/state/liveRepository';
import { useStoryOps } from '@/state/StoryOpsProvider';

function safeMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'The trusted identity boundary returned an unexpected error.';
}

export function IdentityProvisioningPage() {
  const { state } = useStoryOps();
  const repository = useMemo(() => getLiveStoryOpsRepository(), []);
  const [provisioningState, setProvisioningState] = useState<IdentityProvisioningState>();
  const [lastReceipt, setLastReceipt] = useState<IdentityProvisioningReceipt>();
  const [busy, setBusy] = useState(state.dataMode === 'supabase');
  const [error, setError] = useState<string>();
  const visibleError =
    error ??
    (state.dataMode === 'supabase' && !repository
      ? 'The authenticated repository is not configured.'
      : undefined);

  const refresh = useCallback(async () => {
    if (!repository || state.dataMode !== 'supabase') {
      setError('Authenticated Supabase mode is required for identity provisioning.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      setProvisioningState(await repository.loadIdentityProvisioningState());
    } catch (caught) {
      setError(safeMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [repository, state.dataMode]);

  useEffect(() => {
    if (state.dataMode !== 'supabase' || state.authStatus !== 'signed_in') return;
    if (!repository) return;
    let active = true;
    void repository
      .loadIdentityProvisioningState()
      .then((next) => {
        if (active) setProvisioningState(next);
      })
      .catch((caught: unknown) => {
        if (active) setError(safeMessage(caught));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [repository, state.authStatus, state.dataMode]);

  const command = useCallback(
    async (input: IdentityProvisioningInput) => {
      if (!repository || state.dataMode !== 'supabase') {
        setError('Authenticated Supabase mode is required for identity provisioning.');
        return;
      }
      setBusy(true);
      setError(undefined);
      try {
        const receipt = await repository.provisionIdentity(input);
        setLastReceipt(receipt);
        setProvisioningState(await repository.loadIdentityProvisioningState());
      } catch (caught) {
        setError(safeMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [repository, state.dataMode],
  );

  if (state.dataMode !== 'supabase') {
    return (
      <div className="page">
        <PageHeader
          eyebrow="Owner-only access"
          title="Identity provisioning"
          description="This boundary is available only in authenticated Supabase mode."
        />
        <Card className="section-card">
          <div className="empty-state">
            <KeyRound className="empty-state__icon" aria-hidden="true" />
            <h2>No sandbox identity mutations</h2>
            <p>
              Sandbox roles remain local demo views. Configure authenticated mode to invite, link,
              or revoke real company access.
            </p>
          </div>
        </Card>
      </div>
    );
  }

  if (!provisioningState) {
    return (
      <div className="page" aria-busy={busy}>
        <PageHeader
          eyebrow="Owner-only access"
          title="Identity provisioning"
          description="Loading exact tenant access from the trusted server boundary."
        />
        {visibleError ? (
          <div className="company-control-error" role="alert">
            <strong>Identity access could not be loaded</strong>
            <span>{visibleError}</span>
            <Button size="sm" variant="secondary" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        ) : (
          <Card className="section-card">
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </Card>
        )}
      </div>
    );
  }

  return (
    <IdentityProvisioningPanel
      state={provisioningState}
      online={state.online}
      serverVerified={Boolean(state.serverVerifiedAt)}
      busy={busy}
      error={visibleError}
      lastReceipt={lastReceipt}
      onRefresh={refresh}
      onCommand={command}
    />
  );
}
