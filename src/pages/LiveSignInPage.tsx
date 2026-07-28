import { CheckCircle2, KeyRound, LoaderCircle, ShieldCheck, Sparkles } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, Button, Card, Field } from '@/components/ui/Primitives';
import { useStoryOps } from '@/state/StoryOpsProvider';

export function LiveSignInPage() {
  const { state, actions } = useStoryOps();
  const [email, setEmail] = useState(state.authEmail ?? '');
  const checking = state.authStatus === 'checking' || !state.hydrated;
  const sent = state.authStatus === 'link_sent';
  const configurationBlocked = state.liveError?.includes('Live mode requires') ?? false;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void actions.requestMagicLink(email);
  };

  return (
    <main className="live-auth-shell" id="main-content">
      <Card className="live-auth-card">
        <div className="live-auth-brand">
          <span className="brand__mark">
            <Sparkles size={18} />
          </span>
          <span>
            <strong>StoryOps AI</strong>
            <small>Authenticated company workspace</small>
          </span>
        </div>

        {checking ? (
          <div className="live-auth-state" role="status">
            <LoaderCircle className="spin" size={26} />
            <h1>Checking your session</h1>
            <p>Loading only the records allowed by your active company membership.</p>
          </div>
        ) : sent ? (
          <div className="live-auth-state" role="status">
            <CheckCircle2 size={28} />
            <Badge tone="positive">Magic link sent</Badge>
            <h1>Check your email</h1>
            <p>
              Open the secure link sent to <strong>{state.authEmail}</strong>. This screen will load
              your server-derived role after authentication.
            </p>
            <Button variant="secondary" onClick={() => void actions.requestMagicLink(email)}>
              Send another link
            </Button>
          </div>
        ) : (
          <>
            <div className="live-auth-heading">
              <KeyRound size={25} />
              <p className="eyebrow">Live Supabase mode</p>
              <h1>Sign in to your workspace</h1>
              <p>
                StoryOps never accepts a client-selected role. The database derives access from the
                authenticated user and active company membership.
              </p>
            </div>
            {state.liveError && (
              <div className="live-auth-error" role="alert">
                <strong>Live workspace unavailable</strong>
                <span>{state.liveError}</span>
              </div>
            )}
            <form className="live-auth-form" onSubmit={submit}>
              <Field label="Work email" htmlFor="live-auth-email">
                <input
                  id="live-auth-email"
                  className="input"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="owner@yourcompany.com"
                />
              </Field>
              <Button
                type="submit"
                size="lg"
                icon={<ShieldCheck size={16} />}
                disabled={configurationBlocked}
              >
                {configurationBlocked
                  ? 'Complete environment configuration'
                  : 'Email secure sign-in link'}
              </Button>
            </form>
          </>
        )}

        <p className="live-auth-footnote">
          Public anon-key authentication only. Service-role credentials never belong in the browser.
        </p>
      </Card>
    </main>
  );
}
