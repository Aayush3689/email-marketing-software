import { AppTabs, Badge, Button, Card, EmptyState, Input } from '@mail/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CopyPlus, Eye, FileText, Pause, Play, Send, Users, XCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../lib/api.js';

export function CampaignsView() {
  const [tplName, setTplName] = useState('');
  const [tplSubject, setTplSubject] = useState('Welcome to Acme, {{firstName}}');
  const [tplHtml, setTplHtml] = useState('<p>Hi {{firstName}}, your workspace is live.</p>');
  const [previewOut, setPreviewOut] = useState<{ subject: string; htmlBody: string } | null>(null);

  const [consentSource, setConsentSource] = useState('product_signup_form');
  const [contactInput, setContactInput] = useState('alice@example.com, Alice, newsletter');
  const [campName, setCampName] = useState('');
  const [selectedDomainId, setSelectedDomainId] = useState('');
  const [selectedTplId, setSelectedTplId] = useState('');
  const [tagFilter, setTagFilter] = useState('');

  const [supEmail, setSupEmail] = useState('');
  const queryClient = useQueryClient();

  const templatesQuery = useQuery({ queryKey: ['templates'], queryFn: () => api.listTemplates() });
  const contactsQuery = useQuery({ queryKey: ['contacts'], queryFn: () => api.listContacts() });
  const campaignsQuery = useQuery({ queryKey: ['campaigns'], queryFn: () => api.listCampaigns() });
  const domainsQuery = useQuery({ queryKey: ['domains'], queryFn: () => api.listDomains() });
  const suppressionsQuery = useQuery({ queryKey: ['suppressions'], queryFn: () => api.listSuppressions() });

  const createTemplate = useMutation({
    mutationFn: () =>
      api.createTemplate({
        name: tplName.trim(),
        category: 'campaign',
        subject: tplSubject,
        htmlBody: tplHtml,
        textBody: tplSubject,
      }),
    onSuccess: async (res) => {
      setTplName('');
      setSelectedTplId(res.template.id);
      await queryClient.invalidateQueries({ queryKey: ['templates'] });
      toast.success('Template created');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Template creation failed'),
  });

  const runPreview = useMutation({
    mutationFn: () =>
      api.previewTemplate({
        subject: tplSubject,
        htmlBody: tplHtml,
        variables: { firstName: 'Alice' },
      }),
    onSuccess: (res) => setPreviewOut(res),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Preview failed'),
  });

  const duplicateTemplate = useMutation({
    mutationFn: (id: string) => api.duplicateTemplate(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['templates'] });
      toast.success('Template duplicated');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Duplicate failed'),
  });

  const importContacts = useMutation({
    mutationFn: () => {
      const rows = contactInput
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.split(',').map((s) => s.trim()))
        .filter((parts, idx) => !(idx === 0 && (parts[0] ?? '').toLowerCase() === 'email'))
        .map((parts) => ({
          email: parts[0] ?? '',
          firstName: parts[1] ?? '',
          tags: parts[2] ? parts[2].split(/[;|]/).map((t) => t.trim()).filter(Boolean) : [],
        }));
      if (rows.length === 0) {
        throw new Error('Enter at least one valid contact line (email, firstName, tag)');
      }
      return api.importContacts({ consentSource: consentSource.trim(), contacts: rows });
    },
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ['contacts'] });
      toast.success(`Imported ${res.imported} contacts (${res.skippedSuppressed} suppressed skipped)`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Import failed'),
  });

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      if (text.trim()) {
        setContactInput(text.trim());
        toast.info(`Loaded ${file.name} — review and click Import Opted-In Contacts`);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const createCampaign = useMutation({
    mutationFn: () => {
      const verifiedDomains = (domainsQuery.data?.domains ?? []).filter(
        (d) => d.ownershipVerifiedAt && d.sendingEnabled && !d.isSuspended
      );
      const fallbackDomain = domainsQuery.data?.domains[0];
      const domainId = selectedDomainId || verifiedDomains[0]?.id || fallbackDomain?.id || '';
      if (!domainId) throw new Error('Register and verify a sending domain under Domains & DNS first');
      const templateId = selectedTplId || templatesQuery.data?.templates[0]?.id || '';
      if (!templateId) throw new Error('Create a template in the Templates tab first');
      if (campName.trim().length < 2) throw new Error('Campaign name must be at least 2 characters');
      return api.createCampaign({
        domainId,
        templateId,
        name: campName.trim(),
        timezone: 'UTC',
        scheduledAt: null,
        tagFilter: tagFilter.trim() ? tagFilter.trim() : null,
      });
    },
    onSuccess: async () => {
      setCampName('');
      await queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      toast.success('Campaign created');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Campaign creation failed'),
  });

  const campaignAction = useMutation({
    mutationFn: (args: { id: string; action: 'pause' | 'resume' | 'cancel' }) =>
      api.transitionCampaign(args.id, args.action),
    onSuccess: async (res, vars) => {
      await queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      if (vars.action === 'resume') {
        const sent = (res as { dispatchedCount?: number }).dispatchedCount;
        toast.success(
          typeof sent === 'number'
            ? `Campaign started — queued ${sent} email${sent === 1 ? '' : 's'}`
            : 'Campaign started'
        );
      } else {
        toast.success('Campaign updated');
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Campaign action failed'),
  });

  const addSuppression = useMutation({
    mutationFn: () => api.addSuppression({ email: supEmail.trim(), reason: 'manual' }),
    onSuccess: async () => {
      setSupEmail('');
      await queryClient.invalidateQueries({ queryKey: ['suppressions'] });
      toast.success('Added to suppression list');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to add suppression'),
  });

  const removeSuppression = useMutation({
    mutationFn: (id: string) => api.removeSuppression(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['suppressions'] });
      toast.success('Removed suppression');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to remove suppression'),
  });

  const templates = templatesQuery.data?.templates ?? [];
  const contacts = contactsQuery.data?.contacts ?? [];
  const campaigns = campaignsQuery.data?.campaigns ?? [];
  const domains = domainsQuery.data?.domains ?? [];
  const suppressions = suppressionsQuery.data?.suppressions ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-text)]">
          Templates, Audiences &amp; Campaigns
        </h2>
        <p className="text-xs text-[var(--color-text-muted)]">
          Consent-verified bulk sends with automatic suppression enforcement and RFC 8058 unsubscribe
        </p>
      </div>

      <AppTabs.Root defaultValue="campaigns">
        <AppTabs.List className="mb-4 inline-flex gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1 text-xs">
          {[
            { value: 'campaigns', label: `Campaigns (${campaigns.length})` },
            { value: 'templates', label: `Templates (${templates.length})` },
            { value: 'contacts', label: `Contacts (${contacts.length})` },
            { value: 'suppressions', label: `Suppressions (${suppressions.length})` },
          ].map((t) => (
            <AppTabs.Tab
              key={t.value}
              value={t.value}
              className="rounded px-3 py-1.5 font-medium text-[var(--color-text-muted)] data-[selected]:bg-[var(--color-accent)] data-[selected]:text-[var(--color-accent-fg)] cursor-pointer"
            >
              {t.label}
            </AppTabs.Tab>
          ))}
        </AppTabs.List>

        <AppTabs.Panel value="campaigns" className="space-y-4">
          <Card className="p-4 space-y-3">
            {(templates.length === 0 || domains.length === 0) && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                {domains.length === 0
                  ? 'Step 1: Register and verify a sending domain under Domains & DNS.'
                  : 'Step 1: Create at least one email template in the Templates tab before creating a campaign.'}
              </div>
            )}
            <form
              className="grid gap-3 md:grid-cols-5"
              onSubmit={(e) => {
                e.preventDefault();
                createCampaign.mutate();
              }}
            >
              <Input
                placeholder="Campaign name (e.g. Q4 Changelog)"
                value={campName}
                onChange={(e) => setCampName(e.target.value)}
              />
              <select
                value={selectedDomainId || domains[0]?.id || ''}
                onChange={(e) => setSelectedDomainId(e.target.value)}
                className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm"
              >
                {domains.length === 0 ? (
                  <option value="">No domains registered</option>
                ) : (
                  domains.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.domainName}{d.ownershipVerifiedAt ? '' : ' (unverified)'}
                    </option>
                  ))
                )}
              </select>
              <select
                value={selectedTplId || templates[0]?.id || ''}
                onChange={(e) => setSelectedTplId(e.target.value)}
                className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm"
              >
                {templates.length === 0 ? (
                  <option value="">Create a template first</option>
                ) : (
                  templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))
                )}
              </select>
              <Input
                placeholder="Optional tag filter (e.g. newsletter)"
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
              />
              <Button type="submit" disabled={createCampaign.isPending}>
                <Send className="h-3.5 w-3.5" />
                Create Campaign
              </Button>
            </form>
          </Card>

          <Card>
            {campaigns.length === 0 ? (
              <EmptyState
                icon={<Send className="h-5 w-5" />}
                title="No campaigns yet"
                description="Import opted-in contacts and create a template, then launch or schedule your campaign."
              />
            ) : (
              <div className="divide-y divide-[var(--color-border)]">
                {campaigns.map((c) => (
                  <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-xs">
                    <div>
                      <div className="flex items-center gap-2 font-medium text-sm text-[var(--color-text)]">
                        <span>{c.name}</span>
                        <Badge
                          tone={
                            c.status === 'running' || c.status === 'completed'
                              ? 'success'
                              : c.status === 'paused'
                                ? 'warning'
                                : c.status === 'cancelled'
                                  ? 'danger'
                                  : 'neutral'
                          }
                        >
                          {c.status}
                        </Badge>
                      </div>
                      <div className="mt-0.5 text-[var(--color-text-muted)]">
                        Eligible recipients: {c.targetCount} • Sent: {c.sentCount}
                        {c.tagFilter ? ` • Segment tag: ${c.tagFilter}` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {c.status !== 'running' && c.status !== 'cancelled' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => campaignAction.mutate({ id: c.id, action: 'resume' })}
                        >
                          <Play className="h-3.5 w-3.5" /> Start
                        </Button>
                      )}
                      {c.status === 'running' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => campaignAction.mutate({ id: c.id, action: 'pause' })}
                        >
                          <Pause className="h-3.5 w-3.5" /> Pause
                        </Button>
                      )}
                      {c.status !== 'cancelled' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => campaignAction.mutate({ id: c.id, action: 'cancel' })}
                        >
                          <XCircle className="h-3.5 w-3.5 text-red-500" /> Cancel
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </AppTabs.Panel>

        <AppTabs.Panel value="templates" className="grid gap-4 lg:grid-cols-2">
          <Card className="p-4 space-y-3">
            <h3 className="text-sm font-semibold text-[var(--color-text)]">Template Studio</h3>
            <Input
              placeholder="Template name"
              value={tplName}
              onChange={(e) => setTplName(e.target.value)}
            />
            <Input
              placeholder="Subject line with {{variables}}"
              value={tplSubject}
              onChange={(e) => setTplSubject(e.target.value)}
            />
            <textarea
              rows={5}
              value={tplHtml}
              onChange={(e) => setTplHtml(e.target.value)}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 font-mono text-xs text-[var(--color-text)]"
            />
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => runPreview.mutate()}
                disabled={runPreview.isPending}
              >
                <Eye className="h-3.5 w-3.5" /> Preview ({`{{firstName}} = Alice`})
              </Button>
              <Button
                size="sm"
                disabled={createTemplate.isPending || tplName.trim().length < 2}
                onClick={() => createTemplate.mutate()}
              >
                Save Template
              </Button>
            </div>
            {previewOut && (
              <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 text-xs space-y-1">
                <div className="font-medium text-[var(--color-text)]">Subject: {previewOut.subject}</div>
                <div className="font-mono text-[11px] text-[var(--color-text-muted)]">{previewOut.htmlBody}</div>
              </div>
            )}
          </Card>

          <Card className="p-4">
            {templates.length === 0 ? (
              <EmptyState
                icon={<FileText className="h-5 w-5" />}
                title="No templates saved"
                description="Create reusable versioned templates with mustache variable substitution."
              />
            ) : (
              <div className="space-y-2">
                {templates.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between rounded-md border border-[var(--color-border)] p-3 text-xs"
                  >
                    <div>
                      <div className="font-medium text-[var(--color-text)]">{t.name}</div>
                      <div className="text-[var(--color-text-muted)]">
                        v{t.activeVersion} • {t.versions[0]?.subject}
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => duplicateTemplate.mutate(t.id)}>
                      <CopyPlus className="h-3.5 w-3.5" /> Clone
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </AppTabs.Panel>

        <AppTabs.Panel value="contacts" className="grid gap-4 lg:grid-cols-2">
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-[var(--color-text)]">Consent-Gated Contact Import</h3>
              <label className="cursor-pointer rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-text)] hover:opacity-90">
                Upload CSV
                <input type="file" accept=".csv,.txt" className="hidden" onChange={handleCsvUpload} />
              </label>
            </div>
            <p className="text-[11px] text-[var(--color-text-muted)]">
              One contact per line: <code className="font-mono">email, firstName, tag</code> (header row optional).
            </p>
            <Input
              placeholder="Consent proof / source (required)"
              value={consentSource}
              onChange={(e) => setConsentSource(e.target.value)}
            />
            <textarea
              rows={5}
              value={contactInput}
              onChange={(e) => setContactInput(e.target.value)}
              placeholder="email, firstName, tag (one per line)"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 font-mono text-xs text-[var(--color-text)]"
            />
            <Button size="sm" disabled={importContacts.isPending} onClick={() => importContacts.mutate()}>
              Import Opted-In Contacts
            </Button>
          </Card>

          <Card className="p-4">
            {contacts.length === 0 ? (
              <EmptyState
                icon={<Users className="h-5 w-5" />}
                title="Audience is empty"
                description="Import contacts with explicit consentSource metadata. Suppressed emails are skipped automatically."
              />
            ) : (
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {contacts.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between rounded-md border border-[var(--color-border)] px-3 py-2 text-xs"
                  >
                    <div>
                      <div className="font-medium text-[var(--color-text)]">{c.email}</div>
                      <div className="text-[11px] text-[var(--color-text-muted)]">
                        Consent: {c.consentSource} {c.tags.length > 0 ? `• #${c.tags.join(' #')}` : ''}
                      </div>
                    </div>
                    <Badge tone={c.unsubscribedAt ? 'danger' : 'success'}>
                      {c.unsubscribedAt ? 'Unsubscribed' : 'Subscribed'}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </AppTabs.Panel>

        <AppTabs.Panel value="suppressions" className="space-y-4">
          <Card className="p-4">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (supEmail.trim()) addSuppression.mutate();
              }}
            >
              <Input
                type="email"
                placeholder="bounced@domain.com"
                value={supEmail}
                onChange={(e) => setSupEmail(e.target.value)}
                className="max-w-sm"
              />
              <Button type="submit" size="sm" disabled={addSuppression.isPending}>
                Add Suppression
              </Button>
            </form>
          </Card>

          <Card className="p-4">
            {suppressions.length === 0 ? (
              <EmptyState
                icon={<Ban className="h-5 w-5" />}
                title="No suppressed addresses"
                description="Hard bounces, spam complaints, and RFC 8058 one-click unsubscribes appear here automatically."
              />
            ) : (
              <div className="space-y-2">
                {suppressions.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between rounded-md border border-[var(--color-border)] px-3 py-2 text-xs"
                  >
                    <div>
                      <span className="font-medium text-[var(--color-text)]">{s.email}</span>
                      <Badge className="ml-2" tone="warning">
                        {s.reason}
                      </Badge>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => removeSuppression.mutate(s.id)}>
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </AppTabs.Panel>
      </AppTabs.Root>
    </div>
  );
}
