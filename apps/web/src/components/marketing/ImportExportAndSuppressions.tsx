import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppDialog, Badge, Button, Card, EmptyState, Input } from '@mail/ui';
import type { ContactImportJobItem, SuppressionReason } from '@mail/shared-types';
import { AlertTriangle, CheckCircle2, Download, Plus, ShieldBan, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';

function parseQuickCsvPreview(text: string): { headers: string[]; rows: string[][] } {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return { headers: [], rows: [] };
  const splitLine = (line: string) => {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i]!;
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') {
        out.push(cur.trim());
        cur = '';
      } else cur += c;
    }
    out.push(cur.trim());
    return out;
  };
  return { headers: splitLine(lines[0]!), rows: lines.slice(1).map(splitLine) };
}

export function ImportExportWizardSection() {
  const qc = useQueryClient();
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5 | 6 | 7>(1);
  const [fileName, setFileName] = useState<string>('subscribers.csv');
  const [csvText, setCsvText] = useState('email,firstName,lastName,tags\nalice@example.com,Alice,Rivera,Newsletter');
  const [fieldMapping, setFieldMapping] = useState<Record<string, string>>({});
  const [defaultTagsInput, setDefaultTagsInput] = useState('');
  const [consentSource, setConsentSource] = useState('');
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [latestJob, setLatestJob] = useState<ContactImportJobItem | null>(null);

  const jobsQuery = useQuery({ queryKey: ['import-jobs'], queryFn: () => api.listImportJobs() });
  const parsed = parseQuickCsvPreview(csvText);

  const importMutation = useMutation({
    mutationFn: () =>
      api.importSubscribersCsv({
        fileName,
        consentSource: consentSource.trim(),
        defaultTags: defaultTagsInput
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        fieldMapping,
        csvText,
      }),
    onSuccess: async (res) => {
      setLatestJob(res.job);
      setStep(7);
      toast.success(`Import finished: ${res.job.importedCount} new, ${res.job.updatedCount} updated`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['import-jobs'] }),
        qc.invalidateQueries({ queryKey: ['subscribers'] }),
        qc.invalidateQueries({ queryKey: ['tags'] }),
        qc.invalidateQueries({ queryKey: ['campaigns'] }),
      ]);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Import failed'),
  });

  const handleFileUpload = (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? '');
      setCsvText(content);
      const preview = parseQuickCsvPreview(content);
      const autoMap: Record<string, string> = {};
      for (const h of preview.headers) {
        const low = h.toLowerCase();
        if (low.includes('email')) autoMap[h] = 'email';
        else if (low.includes('first')) autoMap[h] = 'firstName';
        else if (low.includes('last')) autoMap[h] = 'lastName';
        else if (low.includes('tag')) autoMap[h] = 'tags';
        else autoMap[h] = low;
      }
      setFieldMapping(autoMap);
      setStep(2);
    };
    reader.readAsText(file);
  };

  const downloadErrors = async (jobId: string) => {
    try {
      const csv = await api.downloadImportErrorsCsv(jobId);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `import-errors-${jobId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed');
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-5 space-y-4 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-text)]">CSV Subscriber Import Wizard</h3>
            <p className="text-[var(--color-text-muted)]">
              Step {step} of 7 • Validates emails, checks suppressions, maps custom attributes, and records verifiable consent.
            </p>
          </div>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setStep(n as 1 | 2 | 3 | 4 | 5 | 6 | 7)}
                className={`h-6 w-6 rounded-full text-[11px] font-medium cursor-pointer ${
                  step === n
                    ? 'bg-[var(--color-accent)] text-[var(--color-accent-fg)]'
                    : step > n
                      ? 'bg-emerald-500/20 text-emerald-600'
                      : 'bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        {step === 1 && (
          <div className="space-y-3">
            <label className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-[var(--color-border)] p-6 hover:bg-[var(--color-surface-muted)]/40 cursor-pointer">
              <Upload className="h-6 w-6 text-[var(--color-text-muted)] mb-2" />
              <span className="font-medium">Choose a CSV file or paste rows below</span>
              <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => handleFileUpload(e.target.files?.[0])} />
            </label>
            <textarea
              rows={5}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 font-mono text-xs"
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
            />
            <div className="flex justify-end">
              <Button onClick={() => setStep(2)} disabled={parsed.rows.length === 0}>
                Next: Parse &amp; Validate ({parsed.rows.length} rows)
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <div className="rounded-md border border-[var(--color-border)] p-3">
              Detected <strong>{parsed.headers.length}</strong> column(s) and <strong>{parsed.rows.length}</strong> data row(s):{' '}
              <span className="font-mono">{parsed.headers.join(', ')}</span>
            </div>
            <div className="flex justify-between">
              <Button variant="secondary" onClick={() => setStep(1)}>Back</Button>
              <Button onClick={() => setStep(3)}>Next: Map Columns</Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <div className="space-y-2">
              {parsed.headers.map((h) => (
                <div key={h} className="grid grid-cols-2 items-center gap-3">
                  <span className="font-mono font-medium">{h}</span>
                  <select
                    className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2"
                    value={fieldMapping[h] ?? h.toLowerCase()}
                    onChange={(e) => setFieldMapping((m) => ({ ...m, [h]: e.target.value }))}
                  >
                    <option value="email">email (Subscriber Email)</option>
                    <option value="firstName">firstName (First Name)</option>
                    <option value="lastName">lastName (Last Name)</option>
                    <option value="tags">tags (Pipe/Semicolon tags)</option>
                    <option value={h.toLowerCase().replace(/[^a-z0-9_]/g, '_')}>Custom field: {h}</option>
                  </select>
                </div>
              ))}
            </div>
            <div className="flex justify-between">
              <Button variant="secondary" onClick={() => setStep(2)}>Back</Button>
              <Button onClick={() => setStep(4)}>Next: Preview Records</Button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-3">
            <div className="overflow-x-auto rounded border border-[var(--color-border)]">
              <table className="w-full text-left text-[11px]">
                <thead className="bg-[var(--color-surface-muted)]">
                  <tr>
                    {parsed.headers.map((h) => (
                      <th key={h} className="p-2">{fieldMapping[h] ?? h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {parsed.rows.slice(0, 5).map((r, i) => (
                    <tr key={i}>
                      {r.map((val, j) => (
                        <td key={j} className="p-2 font-mono">{val}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-between">
              <Button variant="secondary" onClick={() => setStep(3)}>Back</Button>
              <Button onClick={() => setStep(5)}>Next: Select Tags</Button>
            </div>
          </div>
        )}

        {step === 5 && (
          <div className="space-y-3">
            <label className="font-medium block">Tags to apply to all imported subscribers (comma-separated)</label>
            <Input placeholder="Newsletter, Imported 2026" value={defaultTagsInput} onChange={(e) => setDefaultTagsInput(e.target.value)} />
            <div className="flex justify-between">
              <Button variant="secondary" onClick={() => setStep(4)}>Back</Button>
              <Button onClick={() => setStep(6)}>Next: Confirm Consent</Button>
            </div>
          </div>
        )}

        {step === 6 && (
          <div className="space-y-3">
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-amber-800 dark:text-amber-300">
              FastConnect requires verifiable consent metadata before sending marketing emails. Never import purchased or scraped lists.
            </div>
            <div className="space-y-1">
              <label className="font-medium">Consent Source Description *</label>
              <Input
                required
                placeholder="e.g. Newsletter double opt-in export from Stripe customers 2026"
                value={consentSource}
                onChange={(e) => setConsentSource(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 font-medium cursor-pointer">
              <input type="checkbox" checked={consentConfirmed} onChange={(e) => setConsentConfirmed(e.target.checked)} />
              I confirm these subscribers gave explicit permission to receive email from my domain.
            </label>
            <div className="flex justify-between">
              <Button variant="secondary" onClick={() => setStep(5)}>Back</Button>
              <Button
                disabled={!consentConfirmed || consentSource.trim().length < 2 || importMutation.isPending}
                onClick={() => importMutation.mutate()}
              >
                {importMutation.isPending ? 'Importing...' : `Start Import (${parsed.rows.length} rows)`}
              </Button>
            </div>
          </div>
        )}

        {step === 7 && latestJob && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 font-semibold text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" /> Import Complete
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded border border-[var(--color-border)] p-2">Total Rows: <strong>{latestJob.totalRows}</strong></div>
              <div className="rounded border border-[var(--color-border)] p-2">Imported New: <strong>{latestJob.importedCount}</strong></div>
              <div className="rounded border border-[var(--color-border)] p-2">Updated Existing: <strong>{latestJob.updatedCount}</strong></div>
              <div className="rounded border border-[var(--color-border)] p-2">Skipped Duplicates: <strong>{latestJob.skippedDuplicates}</strong></div>
              <div className="rounded border border-[var(--color-border)] p-2">Invalid Emails: <strong>{latestJob.invalidCount}</strong></div>
              <div className="rounded border border-[var(--color-border)] p-2">Suppressed Blocked: <strong>{latestJob.suppressedCount}</strong></div>
              <div className="rounded border border-[var(--color-border)] p-2">Missing Consent: <strong>{latestJob.missingConsentCount}</strong></div>
              <div className="rounded border border-[var(--color-border)] p-2">Failed: <strong>{latestJob.failedCount}</strong></div>
            </div>
            <div className="flex gap-2">
              {latestJob.errorReport.length > 0 && (
                <Button size="sm" variant="secondary" onClick={() => downloadErrors(latestJob.id)}>
                  <Download className="h-3.5 w-3.5" /> Download Error Report CSV
                </Button>
              )}
              <Button size="sm" onClick={() => setStep(1)}>Start Another Import</Button>
            </div>
          </div>
        )}
      </Card>

      {(jobsQuery.data?.jobs.length ?? 0) > 0 && (
        <Card className="p-4 space-y-2 text-xs">
          <div className="font-semibold text-[var(--color-text)]">Recent Import Jobs</div>
          <div className="divide-y divide-[var(--color-border)]">
            {jobsQuery.data!.jobs.map((j) => (
              <div key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <span className="font-medium">{j.fileName ?? 'CSV Upload'}</span> • {j.importedCount} imported / {j.totalRows} rows
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={j.status === 'completed' ? 'success' : 'danger'}>{j.status}</Badge>
                  {j.errorReport.length > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => downloadErrors(j.id)}>
                      Errors CSV
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

export function SuppressionsSection() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [reasonFilter, setReasonFilter] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newReason, setNewReason] = useState<SuppressionReason>('manual');
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  const supQuery = useQuery({
    queryKey: ['suppressions', { search, reasonFilter }],
    queryFn: () =>
      api.listSuppressions({
        search: search.trim() || undefined,
        reason: reasonFilter || undefined,
      }),
  });

  const addMutation = useMutation({
    mutationFn: () => api.addSuppression({ email: newEmail.trim(), reason: newReason }),
    onSuccess: async () => {
      toast.success('Added to suppression list');
      setNewEmail('');
      await Promise.all([qc.invalidateQueries({ queryKey: ['suppressions'] }), qc.invalidateQueries({ queryKey: ['subscribers'] })]);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to add suppression'),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => api.removeSuppression(id),
    onSuccess: async () => {
      toast.success('Removed suppression entry');
      setRemoveTarget(null);
      await qc.invalidateQueries({ queryKey: ['suppressions'] });
    },
  });

  const list = supQuery.data?.suppressions ?? [];

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3 text-xs">
        <div className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 p-3 text-amber-800 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            Suppressed addresses are strictly excluded from all marketing broadcasts and sequences. RFC 8058 one-click unsubscribes, hard SMTP bounces, and ARF complaints automatically populate this registry.
          </div>
        </div>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newEmail.trim()) return;
            addMutation.mutate();
          }}
        >
          <Input className="flex-1 min-w-[200px]" type="email" placeholder="suppress@example.com" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} required />
          <select
            className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5"
            value={newReason}
            onChange={(e) => setNewReason(e.target.value as SuppressionReason)}
          >
            <option value="manual">Manual Suppression</option>
            <option value="hard_bounce">Hard Bounce</option>
            <option value="complaint">Spam Complaint</option>
            <option value="unsubscribe">Unsubscribe</option>
            <option value="invalid_recipient">Invalid Recipient</option>
            <option value="admin">Administrative</option>
          </select>
          <Button type="submit" disabled={addMutation.isPending}>
            <Plus className="h-3.5 w-3.5" /> Suppress Address
          </Button>
        </form>
      </Card>

      <Card className="p-4 space-y-3 text-xs">
        <div className="flex flex-wrap gap-2">
          <Input className="flex-1 min-w-[180px]" placeholder="Filter suppressed emails..." value={search} onChange={(e) => setSearch(e.target.value)} />
          <select
            className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5"
            value={reasonFilter}
            onChange={(e) => setReasonFilter(e.target.value)}
          >
            <option value="">All Reasons</option>
            <option value="hard_bounce">Hard Bounce</option>
            <option value="complaint">Complaint</option>
            <option value="unsubscribe">Unsubscribe</option>
            <option value="manual">Manual</option>
            <option value="invalid_recipient">Invalid Recipient</option>
            <option value="admin">Administrative</option>
          </select>
        </div>

        {list.length === 0 ? (
          <EmptyState icon={<ShieldBan className="h-5 w-5" />} title="No suppressed addresses" description="Bounced, complained, and unsubscribed recipients will appear here." />
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {list.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div>
                  <span className="font-mono font-medium">{s.email}</span>{' '}
                  <Badge tone={s.reason === 'complaint' || s.reason === 'hard_bounce' ? 'danger' : 'warning'}>{s.reason}</Badge>
                  {s.source && <span className="ml-2 text-[var(--color-text-muted)]">via {s.source}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[var(--color-text-muted)]">{new Date(s.createdAt).toLocaleDateString()}</span>
                  <Button size="icon" variant="ghost" className="text-red-500" onClick={() => setRemoveTarget(s.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <AppDialog open={Boolean(removeTarget)} onOpenChange={(o) => !o && setRemoveTarget(null)} title="Remove Suppression Entry?">
        <div className="space-y-3 text-xs">
          <p className="text-[var(--color-text-muted)]">
            Removing a suppression allows future sends only if the subscriber still has active opt-in status. Previously unsubscribed contacts remain unsubscribed until explicit consent resubscribe.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRemoveTarget(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => removeTarget && removeMutation.mutate(removeTarget)}>Remove</Button>
          </div>
        </div>
      </AppDialog>
    </div>
  );
}
