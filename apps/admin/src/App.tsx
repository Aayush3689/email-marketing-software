import { Badge, Button, ErrorBoundary } from '@mail/ui';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  Activity,
  Building2,
  FileClock,
  LogOut,
  Menu,
  Moon,
  Network,
  Server,
  ShieldCheck,
  Sun,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';
import { adminApi, clearAdminToken, getAdminToken } from './lib/api.js';
import { AdminAuthScreen } from './views/AdminAuthScreen.js';
import { ClusterOverviewView } from './views/ClusterOverviewView.js';
import { NodesQueuesView } from './views/NodesQueuesView.js';
import { ReputationPoolsView } from './views/ReputationPoolsView.js';
import { SettingsAuditView } from './views/SettingsAuditView.js';
import { TenantsGovernanceView } from './views/TenantsGovernanceView.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 10_000,
    },
  },
});

const NAV_ITEMS = [
  { to: '/', label: 'Cluster Health', icon: Activity, end: true },
  { to: '/tenants', label: 'Tenants & Domains', icon: Building2, end: false },
  { to: '/infrastructure', label: 'MTA Nodes & Queues', icon: Server, end: false },
  { to: '/reputation', label: 'IP Pools & Throttles', icon: Network, end: false },
  { to: '/governance', label: 'Settings & Audit Log', icon: FileClock, end: false },
] as const;

function AdminShell() {
  const [dark, setDark] = useState(true);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [authedVersion, setAuthedVersion] = useState(0);
  const token = getAdminToken();

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  const meQuery = useQuery({
    queryKey: ['admin-me', authedVersion],
    queryFn: () => adminApi.me(),
    enabled: Boolean(token),
    retry: false,
  });

  if (!token) {
    return <AdminAuthScreen onAuthenticated={() => setAuthedVersion((v) => v + 1)} />;
  }

  if (meQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] text-xs text-[var(--color-text-muted)]">
        Verifying Super Admin MFA session...
      </div>
    );
  }

  const auth = meQuery.data?.auth;
  if (
    meQuery.isError ||
    !auth ||
    !auth.mfaVerified ||
    (auth.platformRole !== 'super_admin' && auth.platformRole !== 'platform_operator')
  ) {
    clearAdminToken();
    return <AdminAuthScreen onAuthenticated={() => setAuthedVersion((v) => v + 1)} />;
  }

  const handleLogout = () => {
    void adminApi.logout().catch(() => undefined);
    clearAdminToken();
    queryClient.clear();
    setAuthedVersion((v) => v + 1);
  };

  return (
    <div className="flex min-h-screen flex-col md:flex-row bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 md:hidden">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4 text-rose-500" />
          <span>MailForge Ops</span>
        </div>
        <Button variant="ghost" size="icon" onClick={() => setMobileNavOpen((v) => !v)} aria-label="Toggle navigation">
          {mobileNavOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
        </Button>
      </header>

      <aside
        className={`${
          mobileNavOpen ? 'flex' : 'hidden'
        } w-full md:w-64 shrink-0 flex-col justify-between border-b md:border-b-0 md:border-r border-[var(--color-border)] bg-[var(--color-surface)] p-4 md:flex`}
      >
        <div className="space-y-6">
          <div className="flex items-center gap-2.5 px-1">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-rose-600 text-white">
              <ShieldCheck className="h-4 w-4" />
            </div>
            <div>
              <div className="text-sm font-semibold leading-tight">MailForge Ops</div>
              <div className="text-[11px] text-[var(--color-text-muted)]">Platform Super Admin</div>
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
          <div className="px-1 space-y-1 text-xs">
            <div className="flex items-center gap-1.5">
              <Badge tone="danger">{auth.platformRole}</Badge>
              <Badge tone="success">MFA</Badge>
            </div>
            <div className="text-[11px] text-[var(--color-text-muted)] truncate">{auth.email}</div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDark((d) => !d)}>
              {dark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
              {dark ? 'Light' : 'Dark'}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleLogout}>
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </Button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 p-5 md:p-8">
        <div className="mx-auto max-w-6xl">
          <Routes>
            <Route path="/" element={<ClusterOverviewView />} />
            <Route path="/tenants" element={<TenantsGovernanceView />} />
            <Route path="/infrastructure" element={<NodesQueuesView />} />
            <Route path="/reputation" element={<ReputationPoolsView />} />
            <Route path="/governance" element={<SettingsAuditView />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary appName="admin">
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AdminShell />
          <Toaster position="bottom-right" richColors />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
