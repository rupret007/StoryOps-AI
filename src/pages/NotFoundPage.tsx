import { ArrowLeft, SearchX } from 'lucide-react';
import { Link } from '@/router';
import { Card, EmptyState } from '@/components/ui/Primitives';

export function NotFoundPage() {
  return (
    <div className="page">
      <Card>
        <EmptyState
          icon={<SearchX size={22} />}
          title="That StoryOps page doesn’t exist"
          description="The record may have moved, or your role may not have access."
          action={
            <Link className="button button--dark button--md" to="/">
              <ArrowLeft size={14} /> Back to command center
            </Link>
          }
        />
      </Card>
    </div>
  );
}
