import { Button, ErrorBoundary } from '@mail/ui';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  CreditCard,
  Globe,
  KeyRound,
  LogOut,
  MailCheck,
  Megaphone,
  Menu,
  Moon,
  Sun,
  Webhook,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { type AuthUser, api, clearStoredTokens, getStoredToken } from './lib/api.js';
import { AuthScreen } from './views/AuthScreen.js';
import { CampaignsView } from './views/CampaignsView.js';
import { CredentialsView } from './views/CredentialsView.js';
import { DomainsView } from './views/DomainsView.js';
import { OverviewView } from './views/OverviewView.js';
import { WebhooksBillingView } from './views/WebhooksBillingView.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 15_000,
    },
  },
});

const NAV_ITEMS = [
  { to: '/', label: 'Overview', icon: BarChart3, end: true },
  { to: '/domains', label: 'Domains & DNS', icon: Globe, end: false },
  { to: '/credentials', label: 'API & SMTP Keys', icon: KeyRound, end: false },
  { to: '/campaigns', label: 'Marketing & Audience', icon: Megaphone, end: false },
  { to: '/webhooks', label: 'Webhooks & Events', icon: Webhook, end: false },
  { to: '/billing', label: 'Billing & Quotas', icon: CreditCard, end: false },
] as const;

function DashboardShell() {
  const [dark, setDark] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [manualUser, setManualUser] = useState<AuthUser | null>(null);
  const hasToken = Boolean(getStoredToken());

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  const meQuery = useQuery({
    queryKey: ['auth-me'],
    queryFn: () => api.me(),
    enabled: hasToken && !manualUser,
    retry: false,
  });

  const activeUser = manualUser ?? meQuery.data?.user ?? null;

  if (!hasToken && !activeUser) {
    return <AuthScreen onAuthenticated={(user) => setManualUser(user)} />;
  }

  if (hasToken && !activeUser && meQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] text-xs text-[var(--color-text-muted)]">
        Loading workspace...
      </div>
    );
  }

  if (hasToken && meQuery.isError && !manualUser) {
    clearStoredTokens();
    return <AuthScreen onAuthenticated={(user) => setManualUser(user)} />;
  }

  const handleLogout = () => {
    void api.logout().catch(() => undefined);
    clearStoredTokens();
    setManualUser(null);
    queryClient.clear();
  };

  return (
    <div className="flex min-h-screen flex-col md:flex-row bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 md:hidden">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <MailCheck className="h-4 w-4 text-[var(--color-brand)]" />
          <span>MailForge</span>
        </div>
        <Button variant="ghost" size="icon" onClick={() => setMobileNavOpen((v) => !v)} aria-label="Toggle navigation">
          {mobileNavOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        </Button>
      </header>

      <aside
        className={`${
          mobileNavOpen ? 'flex' : 'hidden'
        } w-full md:w-60 shrink-0 flex-col justify-between border-b md:border-b-0 md:border-r border-[var(--color-border)] bg-[var(--color-surface)] p-4 md:flex`}
      >
        <div className="space-y-6">
          <div className="flex items-center gap-2.5 px-1">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--color-brand)] text-white">
              <MailCheck className="h-4 w-4" />
            </div>
            <div>
              <div className="text-sm font-semibold leading-tight">MailForge</div>
              <div className="text-[11px] text-[var(--color-text-muted)]">Developer Console</div>
            </div>
          </div>

          <nav className="space-y-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 rounded-md px-2.5 py-2 text-xs font-medium transition-colors ${
                      isActive
                        ? 'bg-[var(--color-surface-muted)] text-[var(--color-text)]'
                        : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]'
                    }`
                  }
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {item.label}
                </NavLink>
              );
            })}
          </nav>
        </div>

        <div className="space-y-3 border-t border-[var(--color-border)] pt-3">
          {activeUser && (
            <div className="px-1 text-xs">
              <div className="font-medium truncate">{activeUser.fullName}</div>
              <div className="text-[11px] text-[var(--color-text-muted)] truncate">{activeUser.email}</div>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDark((d) => !d)}>
              {dark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
              {dark ? 'Light' : 'Dark'}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleLogout}>
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </Button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 p-5 md:p-8">
        <div className="mx-auto max-w-6xl">
          <Routes>
            <Route path="/" element={<OverviewView />} />
            <Route path="/domains" element={<DomainsView />} />
            <Route path="/credentials" element={<CredentialsView />} />
            <Route path="/campaigns" element={<CampaignsView />} />
            <Route path="/webhooks" element={<WebhooksBillingView mode="webhooks" />} />
            <Route path="/billing" element={<WebhooksBillingView mode="billing" />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary appName="web">
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <DashboardShell />
          <Toaster position="bottom-right" richColors />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
