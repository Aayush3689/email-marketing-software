import { Badge, Button, Card, Input } from '@mail/ui';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { adminApi, setAdminToken } from '../lib/api.js';

export function AdminAuthScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [preMfaToken, setPreMfaToken] = useState<string | null>(null);
  const [totpSecret, setTotpSecret] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [busy, setBusy] = useState(false);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await adminApi.login({ email: email.trim(), password });
      if (res.user.platformRole !== 'super_admin' && res.user.platformRole !== 'platform_operator') {
        toast.error('Access denied: super_admin or platform_operator role required');
        return;
      }
      setPreMfaToken(res.accessToken);
      toast.info('Password verified. Complete TOTP MFA challenge.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Admin login failed');
    } finally {
      setBusy(false);
    }
  };

  const handleEnrollTotp = async () => {
    if (!preMfaToken) return;
    setBusy(true);
    try {
      const res = await adminApi.enrollMfa(preMfaToken);
      setTotpSecret(res.secret);
      toast.success('Generated new TOTP authenticator secret');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'MFA enrollment failed');
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyMfa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!preMfaToken) return;
    setBusy(true);
    try {
      const res = await adminApi.verifyMfa(preMfaToken, totpCode.trim());
      setAdminToken(res.accessToken);
      toast.success('MFA session verified');
      onAuthenticated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Invalid TOTP verification code');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-4 py-12">
      <Card className="w-full max-w-md p-6 shadow-sm">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-rose-600 text-white">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-[var(--color-text)]">
                Platform Operations Console
              </h1>
              <p className="text-xs text-[var(--color-text-muted)]">
                MFA-enforced Super Admin control plane
              </p>
            </div>
          </div>
          <Badge tone="danger">RESTRICTED</Badge>
        </div>

        {!preMfaToken ? (
          <form onSubmit={(e) => void handlePasswordSubmit(e)} className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--color-text)]">
                Operator Email
              </label>
              <Input
                type="email"
                placeholder="root@mailforge.internal"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--color-text)]">
                Password
              </label>
              <Input
                type="password"
                placeholder="••••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Authenticating...' : 'Continue to MFA Challenge'}
            </Button>
          </form>
        ) : (
          <form onSubmit={(e) => void handleVerifyMfa(e)} className="space-y-4">
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 text-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-medium text-[var(--color-text)]">Step 2: TOTP Verification</span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void handleEnrollTotp()}
                >
                  <KeyRound className="h-3.5 w-3.5" /> Enroll New TOTP
                </Button>
              </div>
              {totpSecret && (
                <div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 font-mono text-[11px] break-all text-amber-700 dark:text-amber-300">
                  Secret (save in authenticator): {totpSecret}
                </div>
              )}
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--color-text)]">
                6-Digit Authenticator Code
              </label>
              <Input
                placeholder="123456"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                className="font-mono tracking-widest"
                required
              />
            </div>

            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setPreMfaToken(null);
                  setTotpSecret(null);
                  setTotpCode('');
                }}
              >
                Back
              </Button>
              <Button type="submit" className="flex-1" disabled={busy}>
                {busy ? 'Verifying...' : 'Verify MFA & Enter Console'}
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
