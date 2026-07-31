import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { Children, cloneElement, forwardRef, isValidElement, useId } from 'react';
import { LoaderCircle } from 'lucide-react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dark';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ComponentPropsWithoutRef<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    icon,
    children,
    className = '',
    disabled,
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`button button--${variant} button--${size} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <LoaderCircle aria-hidden="true" className="spin" size={16} /> : icon}
      <span>{children}</span>
    </button>
  );
});

type BadgeTone = 'neutral' | 'positive' | 'warning' | 'danger' | 'info' | 'accent' | 'dark';

export function Badge({
  children,
  tone = 'neutral',
  dot = false,
  className = '',
}: {
  children: ReactNode;
  tone?: BadgeTone;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span className={`badge badge--${tone} ${className}`}>
      {dot && <span className="badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function Card({
  children,
  className = '',
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'article' | 'div';
}) {
  return <Tag className={`card ${className}`}>{children}</Tag>;
}

export function Avatar({
  name,
  size = 'md',
  tone = 'green',
}: {
  name: string;
  size?: 'sm' | 'md' | 'lg';
  tone?: 'green' | 'blue' | 'orange' | 'plum';
}) {
  const initials = name
    .split(' ')
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <span className={`avatar avatar--${size} avatar--${tone}`} aria-label={name} title={name}>
      {initials}
    </span>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="page-header__description">{description}</p>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}

export function Progress({
  value,
  max = 100,
  label,
  tone = 'green',
}: {
  value: number;
  max?: number;
  label: string;
  tone?: 'green' | 'lime' | 'orange' | 'blue';
}) {
  const width = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      <span className={`progress__bar progress__bar--${tone}`} style={{ width: `${width}%` }} />
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  const generatedId = `field-${useId().replaceAll(':', '')}`;
  const childArray = Children.toArray(children);
  const onlyChild = childArray.length === 1 ? childArray[0] : undefined;
  const controlElement =
    isValidElement<{
      id?: string;
      'aria-describedby'?: string;
      'aria-invalid'?: ComponentPropsWithoutRef<'input'>['aria-invalid'];
    }>(onlyChild) &&
    typeof onlyChild.type === 'string' &&
    ['input', 'select', 'textarea'].includes(onlyChild.type)
      ? onlyChild
      : undefined;
  const controlId = htmlFor ?? controlElement?.props.id ?? generatedId;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const descriptionId = error ? errorId : hint ? hintId : undefined;
  const describedBy = controlElement
    ? Array.from(
        new Set(
          [controlElement.props['aria-describedby'], descriptionId]
            .flatMap((value) => value?.split(/\s+/u) ?? [])
            .filter(Boolean),
        ),
      ).join(' ') || undefined
    : undefined;
  const describedControl = controlElement
    ? cloneElement(controlElement, {
        id: controlElement.props.id ?? controlId,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : controlElement.props['aria-invalid'],
      })
    : children;

  return (
    <div className="field">
      <label htmlFor={controlId}>{label}</label>
      {describedControl}
      {error ? (
        <span id={errorId} className="field__error" role="alert">
          {error}
        </span>
      ) : (
        hint && (
          <span id={hintId} className="field__hint">
            {hint}
          </span>
        )
      )}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <span className={`skeleton ${className}`} aria-hidden="true" />;
}

export function Metric({
  label,
  value,
  delta,
  icon,
  tone = 'green',
}: {
  label: string;
  value: string;
  delta: string;
  icon: ReactNode;
  tone?: 'green' | 'blue' | 'orange' | 'plum';
}) {
  return (
    <Card className="metric-card">
      <div className={`metric-card__icon metric-card__icon--${tone}`}>{icon}</div>
      <div>
        <p className="metric-card__label">{label}</p>
        <p className="metric-card__value">{value}</p>
        <p className="metric-card__delta">{delta}</p>
      </div>
    </Card>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
