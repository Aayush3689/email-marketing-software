import { Badge, Button, Card, EmptyState, Input } from '@mail/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Code2, KeyRound, RotateCw, Server, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { RevealSecretDialog } from '../components/RevealSecretDialog.js';
import { api } from '../lib/api.js';

export function CredentialsView() {
  const [keyName, setKeyName] = useState('');
  const [senderPattern, setSenderPattern] = useState('*@acme.com');
  const [revealedSecret, setRevealedSecret] = useState<{
    secret: string;
    title: string;
    description: string;
  } | null>(null);

  const queryClient = useQueryClient();

  const keysQuery = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api.listApiKeys(),
  });

  const smtpQuery = useQuery({
    queryKey: ['smtp-credentials'],
    queryFn: () => api.listSmtpCredentials(),
  });

  const createKey = useMutation({
    mutationFn: () =>
      api.createApiKey({
        name: keyName.trim(),
        scopes: ['emails:send', 'domains:read', 'analytics:read'],
        rateLimitRpm: 1200,
      }),
    onSuccess: async (res) => {
      setKeyName('');
      setRevealedSecret({
        secret: res.secret,
        title: 'API Key Created (Shown Once)',
        description:
          'Copy this API key now. It is stored using a one-way SHA-256 hash and cannot be retrieved again.',
      });
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to create API key'),
  });

  const rotateKey = useMutation({
    mutationFn: (id: string) => api.rotateApiKey(id),
    onSuccess: async (res) => {
      setRevealedSecret({
        secret: res.secret,
        title: 'API Key Rotated (Shown Once)',
        description: 'The previous secret is immediately invalidated. Save your new secret now.',
      });
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });

  const revokeKey = useMutation({
    mutationFn: (id: string) => api.revokeApiKey(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      toast.success('API key revoked');
    },
  });

  const createSmtp = useMutation({
    mutationFn: () =>
      api.createSmtpCredential({
        domainId: null,
        allowedSenderPatterns: [senderPattern.trim() || '*'],
        maxRatePerMin: 300,
      }),
    onSuccess: async (res) => {
      setRevealedSecret({
        secret: `Username: ${res.credential.username}\nPassword: ${res.secretPassword}`,
        title: 'SMTP Credential Provisioned (Shown Once)',
        description:
          'SMTP passwords are hashed with Argon2id. Store these credentials securely in your secrets manager.',
      });
      await queryClient.invalidateQueries({ queryKey: ['smtp-credentials'] });
    },
  });

  const rotateSmtp = useMutation({
    mutationFn: (id: string) => api.rotateSmtpCredential(id),
    onSuccess: async (res) => {
      setRevealedSecret({
        secret: `Username: ${res.credential.username}\nPassword: ${res.secretPassword}`,
        title: 'SMTP Password Rotated (Shown Once)',
        description: 'Update your SMTP relay configuration with this rotated password immediately.',
      });
      await queryClient.invalidateQueries({ queryKey: ['smtp-credentials'] });
    },
  });

  const revokeSmtp = useMutation({
    mutationFn: (id: string) => api.revokeSmtpCredential(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['smtp-credentials'] });
      toast.success('SMTP credential revoked');
    },
  });

  const apiKeys = keysQuery.data?.apiKeys ?? [];
  const smtpCreds = smtpQuery.data?.credentials ?? [];

  return (
    <div className="space-y-6">
      <RevealSecretDialog
        secret={revealedSecret?.secret ?? null}
        title={revealedSecret?.title ?? ''}
        description={revealedSecret?.description ?? ''}
        onClose={() => setRevealedSecret(null)}
      />

      <div>
        <h2 className="text-lg font-semibold text-[var(--color-text)]">API Keys &amp; SMTP Relay</h2>
        <p className="text-xs text-[var(--color-text-muted)]">
          Reveal-once credentials hashed with SHA-256 (API) and Argon2id (SMTP submission on port 587)
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-[var(--color-brand)]" />
              <h3 className="text-sm font-semibold text-[var(--color-text)]">REST API Keys</h3>
            </div>
          </div>

          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (keyName.trim().length >= 2) createKey.mutate();
            }}
          >
            <Input
              placeholder="Production Transactional Key"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={createKey.isPending}>
              Create Key
            </Button>
          </form>

          {apiKeys.length === 0 ? (
            <EmptyState
              icon={<KeyRound className="h-5 w-5" />}
              title="No API keys created"
              description="Generate a scoped mk_live_* key to submit emails over HTTPS."
            />
          ) : (
            <div className="space-y-2">
              {apiKeys.map((k) => (
                <div
                  key={k.id}
                  className="flex items-center justify-between rounded-md border border-[var(--color-border)] px-3 py-2 text-xs"
                >
                  <div>
                    <div className="flex items-center gap-2 font-medium text-[var(--color-text)]">
                      <span>{k.name}</span>
                      <Badge tone={k.revokedAt ? 'danger' : 'success'}>
                        {k.revokedAt ? 'Revoked' : 'Active'}
                      </Badge>
                    </div>
                    <div className="font-mono text-[11px] text-[var(--color-text-muted)]">
                      {k.keyPrefix}•••••••• • {k.rateLimitRpm} rpm
                    </div>
                  </div>
                  {!k.revokedAt && (
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" onClick={() => rotateKey.mutate(k.id)} title="Rotate">
                        <RotateCw className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => revokeKey.mutate(k.id)} title="Revoke">
                        <Trash2 className="h-3.5 w-3.5 text-red-500" />
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-[var(--color-brand)]" />
            <h3 className="text-sm font-semibold text-[var(--color-text)]">SMTP Submission Credentials</h3>
          </div>

          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              createSmtp.mutate();
            }}
          >
            <Input
              placeholder="Allowed sender (*@acme.com)"
              value={senderPattern}
              onChange={(e) => setSenderPattern(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={createSmtp.isPending}>
              Create SMTP
            </Button>
          </form>

          {smtpCreds.length === 0 ? (
            <EmptyState
              icon={<Server className="h-5 w-5" />}
              title="No SMTP credentials"
              description="Connect Rails, Django, Laravel, or Ghost via TLS STARTTLS on smtp.mailforge.internal:587."
            />
          ) : (
            <div className="space-y-2">
              {smtpCreds.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between rounded-md border border-[var(--color-border)] px-3 py-2 text-xs"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-medium text-[var(--color-text)]">{c.username}</span>
                      <Badge tone={c.revokedAt ? 'danger' : 'success'}>
                        {c.revokedAt ? 'Revoked' : 'Active'}
                      </Badge>
                    </div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">
                      Senders: {c.allowedSenderPatterns.join(', ')} • {c.maxRatePerMin}/min
                    </div>
                  </div>
                  {!c.revokedAt && (
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon" onClick={() => rotateSmtp.mutate(c.id)} title="Rotate">
                        <RotateCw className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => revokeSmtp.mutate(c.id)} title="Revoke">
                        <Trash2 className="h-3.5 w-3.5 text-red-500" />
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card className="p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Code2 className="h-4 w-4 text-[var(--color-brand)]" />
          <h3 className="text-sm font-semibold text-[var(--color-text)]">Quickstart: Send Transactional Email</h3>
        </div>
        <pre className="overflow-x-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 font-mono text-xs text-[var(--color-text)]">
{`curl -X POST http://localhost:4000/v1/emails \\
  -H "Content-Type: application/json" \\
  -H "x-organization-id: <ORG_ID>" \\
  -H "x-domain-id: <DOMAIN_ID>" \\
  -d '{
    "from": "noreply@acme.com",
    "to": ["user@example.com"],
    "subject": "Verify your account",
    "html": "<p>Welcome to Acme.</p>",
    "idempotencyKey": "signup-user-42"
  }'`}
        </pre>
      </Card>
    </div>
  );
}
