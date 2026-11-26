import { AppDialog, Button, Input } from '@mail/ui';
import {
  AlertTriangle,
  KeyRound,
  MoreHorizontal,
  RefreshCw,
  SearchCheck,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import type { DomainItem, DomainUpdatePatch } from '../../lib/api.js';

interface DependencyCounts {
  mailboxes?: number;
  campaigns?: number;
  smtpCredentials?: number;
  messages?: number;
}

export function DomainActionsMenu({
  domain,
  verifying,
  runningDiagnostics,
  regeneratingToken,
  rotatingDkim,
  deleting,
  deleteDependencies,
  onVerify,
  onRunDiagnostics,
  onRegenerateToken,
  onRotateDkim,
  onUpdateSettings,
  onDeleteDomain,
  onClearDeleteDependencies,
}: {
  domain: DomainItem;
  verifying: boolean;
  runningDiagnostics: boolean;
  regeneratingToken: boolean;
  rotatingDkim: boolean;
  deleting: boolean;
  deleteDependencies: DependencyCounts | null;
  onVerify: () => void;
  onRunDiagnostics: () => void;
  onRegenerateToken: () => void;
  onRotateDkim: (selector?: string, algorithm?: 'rsa2048' | 'ed25519') => void;
  onUpdateSettings: (patch: DomainUpdatePatch) => void;
  onDeleteDomain: (confirmDomainName: string, confirmCleanup: boolean) => Promise<boolean>;
  onClearDeleteDependencies: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const [selectorInput, setSelectorInput] = useState('');
  const [dkimAlgorithm, setDkimAlgorithm] = useState<'rsa2048' | 'ed25519'>('rsa2048');
  const [confirmName, setConfirmName] = useState('');
  const [confirmCleanup, setConfirmCleanup] = useState(false);

  const canDelete = confirmName.trim().toLowerCase() === domain.domainName.toLowerCase();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={onVerify} disabled={verifying}>
        <ShieldCheck className="h-3.5 w-3.5" />
        {verifying ? 'Checking DNS...' : domain.ownershipVerifiedAt ? 'Re-verify DNS' : 'Verify DNS'}
      </Button>

      <Button size="sm" variant="secondary" onClick={onRunDiagnostics} disabled={runningDiagnostics}>
        <SearchCheck className={`h-3.5 w-3.5 ${runningDiagnostics ? 'animate-pulse' : ''}`} />
        {runningDiagnostics ? 'Diagnosing...' : 'Full Check'}
      </Button>

      <div className="relative">
        <Button
          size="sm"
          variant="secondary"
          aria-label="More domain actions"
          onClick={() => setMenuOpen((prev) => !prev)}
        >
          <MoreHorizontal className="h-4 w-4" />
          Actions
        </Button>

        {menuOpen && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 z-30 mt-1 w-60 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-lg text-xs">
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[var(--color-text)] hover:bg-[var(--color-surface-muted)] cursor-pointer"
                onClick={() => {
                  setMenuOpen(false);
                  setRotateOpen(true);
                }}
              >
                <KeyRound className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
                Rotate DKIM Selector...
              </button>

              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[var(--color-text)] hover:bg-[var(--color-surface-muted)] cursor-pointer"
                onClick={() => {
                  setMenuOpen(false);
                  setRegenOpen(true);
                }}
              >
                <RefreshCw className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
                Regenerate Verification Token...
              </button>

              <div className="my-1 border-t border-[var(--color-border)]" />

              <button
                type="button"
                className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-[var(--color-text)] hover:bg-[var(--color-surface-muted)] cursor-pointer"
                onClick={() => {
                  setMenuOpen(false);
                  onUpdateSettings({ sendingEnabled: !domain.sendingEnabled });
                }}
              >
                <span>{domain.sendingEnabled ? 'Disable Outbound Sending' : 'Enable Outbound Sending'}</span>
              </button>

              <button
                type="button"
                className="flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-[var(--color-text)] hover:bg-[var(--color-surface-muted)] cursor-pointer"
                onClick={() => {
                  setMenuOpen(false);
                  onUpdateSettings({ hostingEnabled: !domain.hostingEnabled });
                }}
              >
                <span>{domain.hostingEnabled ? 'Disable Inbound Hosting' : 'Enable Inbound Hosting'}</span>
              </button>

              <div className="my-1 border-t border-[var(--color-border)]" />

              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-red-600 dark:text-red-400 hover:bg-red-500/10 cursor-pointer"
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmName('');
                  setConfirmCleanup(false);
                  onClearDeleteDependencies();
                  setDeleteOpen(true);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete Domain...
              </button>
            </div>
          </>
        )}
      </div>

      {/* Regenerate verification token confirmation */}
      <AppDialog
        open={regenOpen}
        onOpenChange={setRegenOpen}
        title={`Regenerate token for ${domain.domainName}`}
      >
        <div className="space-y-3 text-xs">
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              Generating a new verification token clears the current ownership verification timestamp until you update the
              <span className="font-mono"> _mailplat-verify </span> TXT record in your DNS provider and re-verify.
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setRegenOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={regeneratingToken}
              onClick={() => {
                onRegenerateToken();
                setRegenOpen(false);
              }}
            >
              {regeneratingToken ? 'Regenerating...' : 'Confirm Regenerate'}
            </Button>
          </div>
        </div>
      </AppDialog>

      {/* Rotate DKIM selector dialog */}
      <AppDialog
        open={rotateOpen}
        onOpenChange={setRotateOpen}
        title={`Rotate DKIM key for ${domain.domainName}`}
      >
        <form
          className="space-y-3 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            onRotateDkim(selectorInput.trim() || undefined, dkimAlgorithm);
            setSelectorInput('');
            setRotateOpen(false);
          }}
        >
          <p className="text-[var(--color-text-muted)]">
            A new DKIM keypair will be generated and encrypted on the server. Previously active keys remain in verifying/inactive coexistence until you revoke them, allowing smooth DNS propagation before switching signatures.
          </p>
          <div className="space-y-1">
            <label className="font-medium text-[var(--color-text)]">Custom Selector (optional)</label>
            <Input
              placeholder="Auto-generate (e.g. mp20261126)"
              value={selectorInput}
              onChange={(e) => setSelectorInput(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label className="font-medium text-[var(--color-text)]">Signing Algorithm</label>
            <select
              className="h-9 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-xs"
              value={dkimAlgorithm}
              onChange={(e) => setDkimAlgorithm(e.target.value as 'rsa2048' | 'ed25519')}
            >
              <option value="rsa2048">RSA 2048-bit (Universal compatibility, recommended)</option>
              <option value="ed25519">Ed25519 (Modern compact keys)</option>
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" type="button" variant="secondary" onClick={() => setRotateOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" type="submit" disabled={rotatingDkim}>
              {rotatingDkim ? 'Generating...' : 'Generate & Rotate Key'}
            </Button>
          </div>
        </form>
      </AppDialog>

      {/* Safe delete domain dialog */}
      <AppDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${domain.domainName}`}
      >
        <form
          className="space-y-3 text-xs"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!canDelete) return;
            if (deleteDependencies && !confirmCleanup) return;
            const deleted = await onDeleteDomain(confirmName.trim(), confirmCleanup);
            if (deleted) {
              setDeleteOpen(false);
            }
          }}
        >
          <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-red-700 dark:text-red-300">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              Deleting this domain removes its DKIM signing keys, DNS check history, and stops outbound and inbound routing for <span className="font-mono font-semibold">{domain.domainName}</span>.
            </div>
          </div>

          {deleteDependencies && (
            <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-amber-800 dark:text-amber-300">
              <div className="font-semibold">Associated resources detected</div>
              <ul className="list-disc pl-4 space-y-0.5">
                {typeof deleteDependencies.mailboxes === 'number' && deleteDependencies.mailboxes > 0 && (
                  <li>{deleteDependencies.mailboxes} hosted mailbox(es)</li>
                )}
                {typeof deleteDependencies.campaigns === 'number' && deleteDependencies.campaigns > 0 && (
                  <li>{deleteDependencies.campaigns} campaign(s)</li>
                )}
                {typeof deleteDependencies.smtpCredentials === 'number' && deleteDependencies.smtpCredentials > 0 && (
                  <li>{deleteDependencies.smtpCredentials} domain-scoped SMTP credential(s)</li>
                )}
                {typeof deleteDependencies.messages === 'number' && deleteDependencies.messages > 0 && (
                  <li>{deleteDependencies.messages} recorded email message(s)</li>
                )}
              </ul>
              <label className="flex items-center gap-2 pt-1 font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={confirmCleanup}
                  onChange={(e) => setConfirmCleanup(e.target.checked)}
                />
                Confirm cascading cleanup / archival of dependent records
              </label>
            </div>
          )}

          <div className="space-y-1">
            <label className="font-medium text-[var(--color-text)]">
              Type <span className="font-mono">{domain.domainName}</span> to confirm
            </label>
            <Input
              placeholder={domain.domainName}
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" type="button" variant="secondary" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              type="submit"
              variant="danger"
              disabled={deleting || !canDelete || Boolean(deleteDependencies && !confirmCleanup)}
            >
              {deleting ? 'Deleting...' : deleteDependencies ? 'Force Delete Domain' : 'Delete Domain'}
            </Button>
          </div>
        </form>
      </AppDialog>
    </div>
  );
}
