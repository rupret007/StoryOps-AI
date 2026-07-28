import {
  createContext,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

export interface StoryOpsLocation {
  pathname: string;
  search: string;
  hash: string;
}

type NavigateOptions = {
  replace?: boolean;
};

type Navigate = (destination: string | number, options?: NavigateOptions) => void;

interface RouterValue {
  location: StoryOpsLocation;
  navigate: Navigate;
}

const RouterContext = createContext<RouterValue | null>(null);

function browserLocation(): StoryOpsLocation {
  return {
    pathname: window.location.pathname || '/',
    search: window.location.search,
    hash: window.location.hash,
  };
}

function safeDestination(destination: string, current: StoryOpsLocation): StoryOpsLocation {
  const hasControlCharacter = [...destination].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (
    !destination.startsWith('/') ||
    destination.startsWith('//') ||
    destination.includes('\\') ||
    hasControlCharacter
  ) {
    throw new Error('StoryOps navigation only accepts same-origin absolute paths.');
  }

  const parsed = new URL(destination, 'https://storyops.local');
  return {
    pathname: parsed.pathname || '/',
    search: parsed.search,
    hash: parsed.hash || current.hash,
  };
}

function locationHref(location: StoryOpsLocation) {
  return `${location.pathname}${location.search}${location.hash}`;
}

export function BrowserRouter({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<StoryOpsLocation>(browserLocation);

  useEffect(() => {
    const handlePopState = () => setLocation(browserLocation());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback<Navigate>(
    (destination, options) => {
      if (typeof destination === 'number') {
        window.history.go(destination);
        return;
      }
      const next = safeDestination(destination, location);
      const href = locationHref(next);
      if (options?.replace) {
        window.history.replaceState(null, '', href);
      } else {
        window.history.pushState(null, '', href);
      }
      setLocation(next);
      window.scrollTo({ top: 0, behavior: 'instant' });
    },
    [location],
  );

  const value = useMemo(() => ({ location, navigate }), [location, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function MemoryRouter({
  children,
  initialEntries = ['/'],
}: {
  children: ReactNode;
  initialEntries?: string[];
}) {
  const initial = safeDestination(initialEntries.at(-1) ?? '/', {
    pathname: '/',
    search: '',
    hash: '',
  });
  const [entries, setEntries] = useState([initial]);
  const [index, setIndex] = useState(0);
  const location = entries[index] ?? initial;

  const navigate = useCallback<Navigate>(
    (destination, options) => {
      if (typeof destination === 'number') {
        setIndex((current) => Math.max(0, Math.min(entries.length - 1, current + destination)));
        return;
      }
      const next = safeDestination(destination, location);
      if (options?.replace) {
        setEntries((current) =>
          current.map((entry, entryIndex) => (entryIndex === index ? next : entry)),
        );
      } else {
        setEntries((current) => [...current.slice(0, index + 1), next]);
        setIndex(index + 1);
      }
    },
    [entries.length, index, location],
  );

  const value = useMemo(() => ({ location, navigate }), [location, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

function useRouter() {
  const value = useContext(RouterContext);
  if (!value) throw new Error('StoryOps router hooks must be used inside a router.');
  return value;
}

export function useLocation() {
  return useRouter().location;
}

export function useNavigate() {
  return useRouter().navigate;
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  to: string;
};

function shouldHandleLink(event: MouseEvent<HTMLAnchorElement>) {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    (!event.currentTarget.target || event.currentTarget.target === '_self')
  );
}

export function Link({ to, onClick, ...props }: LinkProps) {
  const navigate = useNavigate();
  safeDestination(to, useLocation());
  return (
    <a
      {...props}
      href={to}
      onClick={(event) => {
        onClick?.(event);
        if (shouldHandleLink(event)) {
          event.preventDefault();
          navigate(to);
        }
      }}
    />
  );
}

export function NavLink({
  to,
  end = false,
  className = '',
  ...props
}: LinkProps & { end?: boolean }) {
  const location = useLocation();
  const isActive = end
    ? location.pathname === to
    : location.pathname === to || location.pathname.startsWith(`${to}/`);
  return (
    <Link
      {...props}
      to={to}
      aria-current={isActive ? 'page' : undefined}
      className={`${className} ${isActive ? 'active' : ''}`.trim()}
    />
  );
}

export function useSearchParams(): [
  URLSearchParams,
  (next: URLSearchParams | Record<string, string>) => void,
] {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const setParams = useCallback(
    (next: URLSearchParams | Record<string, string>) => {
      const query = next instanceof URLSearchParams ? next : new URLSearchParams(next);
      const search = query.toString();
      navigate(`${location.pathname}${search ? `?${search}` : ''}`);
    },
    [location.pathname, navigate],
  );
  return [params, setParams];
}

export function Navigate({ to, replace = false }: { to: string; replace?: boolean }) {
  const navigate = useNavigate();
  useEffect(() => navigate(to, { replace }), [navigate, replace, to]);
  return null;
}
