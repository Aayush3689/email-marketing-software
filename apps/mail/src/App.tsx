import { Badge, Button, Card, EmptyState, Input, Skeleton } from '@mail/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  FileEdit,
  Folder,
  Inbox,
  LogOut,
  Mail,
  Menu,
  Moon,
  Plus,
  Send,
  Settings,
  ShieldAlert,
  Star,
  Sun,
  Tag,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast, Toaster } from 'sonner';
import { ComposeDialog, type ComposeInitialState } from './components/ComposeDialog.js';
import { SearchBar, type SearchFilterState } from './components/SearchBar.js';
import { ThreadReader } from './components/ThreadReader.js';
import { WebmailApiClient, type MessageDto } from './lib/api.js';

const FOLDER_ICONS: Record<string, React.ReactNode> = {
  inbox: <Inbox className="h-4 w-4" />,
  starred: <Star className="h-4 w-4" />,
  important: <Tag className="h-4 w-4" />,
  sent: <Send className="h-4 w-4" />,
  drafts: <FileEdit className="h-4 w-4" />,
  archive: <Archive className="h-4 w-4" />,
  spam: <ShieldAlert className="h-4 w-4" />,
  trash: <Trash2 className="h-4 w-4" />,
};

export function App() {
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('mail_token'));
  const [mailboxEmail, setMailboxEmail] = useState<string>(
    () => localStorage.getItem('mail_address') ?? ''
  );
  const [dark, setDark] = useState(false);
  const [mobileRailOpen, setMobileRailOpen] = useState(false);
  const [activeView, setActiveView] = useState<'mail' | 'contacts' | 'settings'>('mail');
  const [activeFolder, setActiveFolder] = useState('inbox');
  const [activeLabel, setActiveLabel] = useState<string | undefined>(undefined);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeInitial, setComposeInitial] = useState<ComposeInitialState | undefined>(undefined);
  const [filters, setFilters] = useState<SearchFilterState>({
    q: '',
    from: '',
    to: '',
    subject: '',
    dateFrom: '',
    dateTo: '',
    hasAttachment: false,
    unreadOnly: false,
  });

  const searchInputRef = useRef<HTMLInputElement>(null);
  const api = useMemo(() => new WebmailApiClient(() => token), [token]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  // Real-time SSE mailbox refresh (driven by Dovecot IMAP IDLE)
  useEffect(() => {
    if (!token) return;
    const es = new EventSource(`/mail/v1/events?token=${encodeURIComponent(token)}`);
    es.onmessage = () => {
      void qc.invalidateQueries({ queryKey: ['folders'] });
      void qc.invalidateQueries({ queryKey: ['threads'] });
    };
    return () => es.close();
  }, [token, qc]);

  const foldersQuery = useQuery({
    queryKey: ['folders'],
    queryFn: () => api.getFolders(),
    enabled: Boolean(token),
  });

  const threadsQuery = useQuery({
    queryKey: ['threads', activeFolder, activeLabel, filters],
    queryFn: () =>
      api.listThreads({
        folder: activeFolder,
        label: activeLabel,
        q: filters.q,
        from: filters.from,
        to: filters.to,
        subject: filters.subject,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        hasAttachment: filters.hasAttachment || undefined,
        unreadOnly: filters.unreadOnly || undefined,
        page: 1,
        pageSize: 50,
      }),
    enabled: Boolean(token) && activeView === 'mail',
  });

  const threadDetailQuery = useQuery({
    queryKey: ['thread', selectedThreadId],
    queryFn: () => api.getThread(selectedThreadId!),
    enabled: Boolean(token && selectedThreadId),
  });

  const contactsQuery = useQuery({
    queryKey: ['contacts'],
    queryFn: () => api.listContacts(),
    enabled: Boolean(token) && activeView === 'contacts',
  });

  const settingsQuery = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
    enabled: Boolean(token),
  });

  const patchMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<WebmailApiClient['patchMessage']>[1] }) =>
      api.patchMessage(id, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['folders'] });
      void qc.invalidateQueries({ queryKey: ['threads'] });
      if (selectedThreadId) void qc.invalidateQueries({ queryKey: ['thread', selectedThreadId] });
    },
  });

  // Keyboard shortcuts (`/` search, `c` compose, `j`/`k` thread navigation)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === '/') {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === 'c') {
        e.preventDefault();
        setComposeInitial(undefined);
        setComposeOpen(true);
      } else if (e.key === 'j' || e.key === 'k') {
        const list = threadsQuery.data?.threads ?? [];
        if (list.length === 0) return;
        const idx = list.findIndex((t) => t.threadId === selectedThreadId);
        const nextIdx =
          e.key === 'j'
            ? Math.min(list.length - 1, idx + 1)
            : Math.max(0, idx <= 0 ? 0 : idx - 1);
        setSelectedThreadId(list[nextIdx]!.threadId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [threadsQuery.data, selectedThreadId]);

  if (!token) {
    return (
      <LoginScreen
        onLoggedIn={(nextToken, email) => {
          localStorage.setItem('mail_token', nextToken);
          localStorage.setItem('mail_address', email);
          setToken(nextToken);
          setMailboxEmail(email);
        }}
        api={api}
      />
    );
  }

  const handleReply = (mode: 'reply' | 'replyAll' | 'forward', msg: MessageDto) => {
    const prefix = mode === 'forward' ? 'Fwd: ' : 'Re: ';
    const subject = msg.subject.startsWith(prefix) ? msg.subject : `${prefix}${msg.subject}`;
    setComposeInitial({
      to: mode === 'forward' ? '' : msg.from.address,
      cc: mode === 'replyAll' ? msg.cc.map((c) => c.address).join(', ') : '',
      subject,
      body: `\n\n--- On ${msg.receivedAt}, ${msg.from.address} wrote ---\n${msg.textBody}`,
      ...(mode !== 'forward' ? { inReplyToThreadId: msg.threadId } : {}),
    });
    setComposeOpen(true);
  };

  const settings = settingsQuery.data?.settings;
  const usedMb = settings ? (settings.usedBytes / 1_048_576).toFixed(1) : '0';
  const quotaGb = settings ? (settings.quotaBytes / 1_073_741_824).toFixed(1) : '5';

  return (
    <div className="flex h-screen flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      <Toaster position="bottom-right" />

      {/* Top Header */}
      <header className="flex h-14 items-center justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4">
        <div className="flex items-center gap-2 font-semibold text-sm shrink-0">
          <Button
            size="icon"
            variant="ghost"
            className="md:hidden"
            aria-label="Toggle folders"
            onClick={() => setMobileRailOpen((v) => !v)}
          >
            {mobileRailOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </Button>
          <Mail className="h-4 w-4 text-[var(--color-brand)]" />
          <span>Webmail</span>
          <Badge tone="neutral">{mailboxEmail}</Badge>
        </div>

        <SearchBar filters={filters} onChange={setFilters} inputRef={searchInputRef} />

        <div className="flex items-center gap-1.5 shrink-0">
          <Button size="icon" variant="ghost" onClick={() => setDark((d) => !d)} title="Toggle theme">
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title="Sign out"
            onClick={() => {
              localStorage.removeItem('mail_token');
              setToken(null);
            }}
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left Navigation Rail */}
        <aside
          className={`${
            mobileRailOpen ? 'flex absolute inset-y-14 left-0 z-30 shadow-lg' : 'hidden'
          } w-56 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] p-3 flex-col justify-between overflow-y-auto md:static md:flex md:shadow-none`}
        >
          <div className="space-y-4">
            <Button
              className="w-full justify-start"
              onClick={() => {
                setComposeInitial(undefined);
                setComposeOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> Compose
            </Button>

            <nav className="space-y-0.5 text-xs">
              {(foldersQuery.data?.folders ?? []).map((f) => {
                const active = activeView === 'mail' && activeFolder === f.id && !activeLabel;
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => {
                      setActiveView('mail');
                      setActiveFolder(f.id);
                      setActiveLabel(undefined);
                      setSelectedThreadId(null);
                    }}
                    className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 cursor-pointer ${
                      active
                        ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand)] font-medium'
                        : 'text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      {FOLDER_ICONS[f.id] ?? <Folder className="h-4 w-4" />}
                      {f.name}
                    </span>
                    {f.unreadCount > 0 && (
                      <span className="text-[11px] font-semibold">{f.unreadCount}</span>
                    )}
                  </button>
                );
              })}
            </nav>

            <div className="pt-2 border-t border-[var(--color-border)] space-y-0.5 text-xs">
              <div className="px-2.5 pb-1 text-[11px] font-medium text-[var(--color-text-muted)]">
                Workspace
              </div>
              <button
                type="button"
                onClick={() => setActiveView('contacts')}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 cursor-pointer ${
                  activeView === 'contacts'
                    ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand)] font-medium'
                    : 'hover:bg-[var(--color-surface-muted)]'
                }`}
              >
                <Users className="h-4 w-4" /> Contacts
              </button>
              <button
                type="button"
                onClick={() => setActiveView('settings')}
                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 cursor-pointer ${
                  activeView === 'settings'
                    ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand)] font-medium'
                    : 'hover:bg-[var(--color-surface-muted)]'
                }`}
              >
                <Settings className="h-4 w-4" /> Settings
              </button>
            </div>
          </div>

          <div className="pt-3 border-t border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)]">
            Storage: {usedMb} MB / {quotaGb} GB
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="flex flex-1 overflow-hidden">
          {activeView === 'mail' && (
            <>
              <section className="w-96 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] overflow-y-auto">
                {threadsQuery.isLoading ? (
                  <div className="p-4 space-y-3">
                    <Skeleton className="h-14 w-full" />
                    <Skeleton className="h-14 w-full" />
                    <Skeleton className="h-14 w-full" />
                  </div>
                ) : (threadsQuery.data?.threads.length ?? 0) === 0 ? (
                  <EmptyState
                    icon={<Inbox className="h-5 w-5" />}
                    title="No conversations"
                    description="Nothing matches this folder or search filter."
                  />
                ) : (
                  threadsQuery.data!.threads.map((t) => (
                    <div
                      key={t.threadId}
                      onClick={() => setSelectedThreadId(t.threadId)}
                      className={`border-b border-[var(--color-border)] px-4 py-3 cursor-pointer ${
                        selectedThreadId === t.threadId
                          ? 'bg-[var(--color-brand-soft)]'
                          : 'hover:bg-[var(--color-surface-muted)]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span
                          className={`truncate ${
                            t.unreadCount > 0 ? 'font-semibold text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'
                          }`}
                        >
                          {t.participants.map((p) => p.name || p.address).join(', ')}
                          {t.messageCount > 1 && ` (${t.messageCount})`}
                        </span>
                        <span className="text-[11px] text-[var(--color-text-muted)] shrink-0">
                          {new Date(t.lastMessageAt).toLocaleDateString()}
                        </span>
                      </div>
                      <div
                        className={`mt-0.5 text-xs truncate ${
                          t.unreadCount > 0 ? 'font-semibold' : 'font-normal'
                        }`}
                      >
                        {t.subject}
                      </div>
                      <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)] truncate">
                        {t.snippet}
                      </div>
                    </div>
                  ))
                )}
              </section>

              <section className="flex-1 bg-[var(--color-bg)] overflow-hidden">
                {selectedThreadId && threadDetailQuery.data ? (
                  <ThreadReader
                    messages={threadDetailQuery.data.messages}
                    onPatch={(id, patch) => patchMut.mutate({ id, patch })}
                    onReply={handleReply}
                    onDownloadAttachment={(messageId, partId, filename) => {
                      void api.downloadAttachment(messageId, partId, filename).catch((err) => {
                        toast.error(err instanceof Error ? err.message : 'Download failed');
                      });
                    }}
                  />
                ) : (
                  <EmptyState
                    icon={<Mail className="h-5 w-5" />}
                    title="Select a conversation"
                    description="Choose a thread from the list or press 'c' to compose a new message."
                  />
                )}
              </section>
            </>
          )}

          {activeView === 'contacts' && (
            <div className="p-6 max-w-3xl w-full overflow-y-auto space-y-4">
              <h2 className="text-base font-semibold">Contacts</h2>
              <Card className="divide-y divide-[var(--color-border)]">
                {(contactsQuery.data?.contacts ?? []).map((c) => (
                  <div key={c.id} className="flex items-center justify-between px-4 py-3 text-sm">
                    <div>
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-[var(--color-text-muted)]">{c.email}</div>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setComposeInitial({ to: c.email });
                        setComposeOpen(true);
                      }}
                    >
                      Email
                    </Button>
                  </div>
                ))}
              </Card>
            </div>
          )}

          {activeView === 'settings' && (
            <SettingsView api={api} settings={settings} onSaved={() => void qc.invalidateQueries({ queryKey: ['settings'] })} />
          )}
        </main>
      </div>

      <ComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        api={api}
        {...(composeInitial !== undefined ? { initial: composeInitial } : {})}
        {...(settings?.signatureHtml !== undefined ? { signatureHtml: settings.signatureHtml } : {})}
        {...(settings?.signatureEnabled !== undefined ? { signatureEnabled: settings.signatureEnabled } : {})}
        onSent={() => {
          void qc.invalidateQueries({ queryKey: ['folders'] });
          void qc.invalidateQueries({ queryKey: ['threads'] });
        }}
      />
    </div>
  );
}

function LoginScreen({
  api,
  onLoggedIn,
}: {
  api: WebmailApiClient;
  onLoggedIn: (token: string, email: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await api.login(email, password);
      onLoggedIn(res.token, res.mailboxEmail);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] p-4">
      <Toaster position="bottom-right" />
      <Card className="w-full max-w-sm p-6 space-y-4">
        <div className="flex items-center gap-2 font-semibold text-base">
          <Mail className="h-5 w-5 text-[var(--color-brand)]" />
          <span>Sign in to Webmail</span>
        </div>
        <form onSubmit={(e) => void submit(e)} className="space-y-3 text-xs">
          <div>
            <label className="block mb-1 text-[var(--color-text-muted)]">Mailbox address</label>
            <Input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </div>
          <div>
            <label className="block mb-1 text-[var(--color-text-muted)]">Password</label>
            <Input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </div>
  );
}

function SettingsView({
  api,
  settings,
  onSaved,
}: {
  api: WebmailApiClient;
  settings?: { signatureHtml: string; signatureEnabled: boolean; displayName: string } | undefined;
  onSaved: () => void;
}) {
  const [sig, setSig] = useState(settings?.signatureHtml ?? '');
  const [enabled, setEnabled] = useState(settings?.signatureEnabled ?? true);

  useEffect(() => {
    if (settings) {
      setSig(settings.signatureHtml);
      setEnabled(settings.signatureEnabled);
    }
  }, [settings]);

  const save = async () => {
    await api.updateSettings({ signatureHtml: sig, signatureEnabled: enabled });
    toast.success('Signature settings saved');
    onSaved();
  };

  return (
    <div className="p-6 max-w-2xl w-full space-y-4">
      <h2 className="text-base font-semibold">Mailbox Settings</h2>
      <Card className="p-4 space-y-3 text-xs">
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Append email signature automatically
        </label>
        <textarea
          rows={5}
          value={sig}
          onChange={(e) => setSig(e.target.value)}
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 text-sm"
        />
        <Button size="sm" onClick={() => void save()}>
          Save settings
        </Button>
      </Card>
    </div>
  );
}
