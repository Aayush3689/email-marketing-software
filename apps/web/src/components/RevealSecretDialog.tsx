import { AppDialog, Button } from '@mail/ui';
import { Check, Copy, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

export function RevealSecretDialog({
  secret,
  title,
  description,
  onClose,
}: {
  secret: string | null;
  title: string;
  description: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!secret) return;
    await navigator.clipboard.writeText(secret);
    setCopied(true);
    toast.success('Copied secret to clipboard');
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <AppDialog open={secret !== null} onOpenChange={(open) => !open && onClose()} title={title}>
      <div className="space-y-4">
        <div className="flex items-start gap-2.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{description}</p>
        </div>

        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 font-mono text-xs break-all text-[var(--color-text)]">
          {secret}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => void handleCopy()}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy Secret'}
          </Button>
          <Button size="sm" onClick={onClose}>
            Done — I saved it
          </Button>
        </div>
      </div>
    </AppDialog>
  );
}
