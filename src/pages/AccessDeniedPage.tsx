import { ArrowLeft, LockKeyhole } from 'lucide-react';
import { useNavigate } from '@/router';
import type { Permission } from '@/domain';
import { useStoryOps } from '@/state/StoryOpsProvider';
import { Button, Card, EmptyState } from '@/components/ui/Primitives';

export function AccessDeniedPage({ permission }: { permission: Permission }) {
  const { state } = useStoryOps();
  const navigate = useNavigate();
  return (
    <div className="page">
      <Card>
        <EmptyState
          icon={<LockKeyhole size={22} />}
          title="This role has read-only or no access"
          description={`The ${state.role} role does not have “${permission}”. WashOps checks this in the UI and again inside every executor and database policy.`}
          action={
            <Button variant="dark" onClick={() => navigate(-1)} icon={<ArrowLeft size={14} />}>
              Go back
            </Button>
          }
        />
      </Card>
    </div>
  );
}
