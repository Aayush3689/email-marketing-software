import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Card, Input } from '@mail/ui';
import { MailCheck } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { type AuthUser, api, setStoredTokens } from '../lib/api.js';

const loginSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const registerSchema = loginSchema.extend({
  fullName: z.string().min(2, 'Enter your full name'),
  organizationName: z.string().min(2, 'Enter an organization name'),
});

type RegisterValues = z.infer<typeof registerSchema>;

export function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<RegisterValues>({
    resolver: zodResolver(mode === 'register' ? registerSchema : loginSchema),
    defaultValues: {
      email: '',
      password: '',
      fullName: '',
      organizationName: '',
    },
  });

  const onSubmit = async (values: RegisterValues) => {
    setSubmitting(true);
    try {
      const res =
        mode === 'register'
          ? await api.register(values)
          : await api.login({ email: values.email, password: values.password });
      setStoredTokens(res.accessToken, res.refreshToken);
      onAuthenticated(res.user);
      toast.success(mode === 'register' ? 'Workspace created' : 'Signed in');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-4 py-12">
      <Card className="w-full max-w-md p-6 shadow-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--color-brand)] text-white">
            <MailCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-[var(--color-text)]">MailForge Console</h1>
            <p className="text-xs text-[var(--color-text-muted)]">
              Transactional & bulk email infrastructure
            </p>
          </div>
        </div>

        <div className="mb-5 grid grid-cols-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-1 text-xs">
          <button
            type="button"
            className={`rounded py-1.5 font-medium transition-colors cursor-pointer ${
              mode === 'register'
                ? 'bg-[var(--color-surface)] text-[var(--color-text)] shadow-xs'
                : 'text-[var(--color-text-muted)]'
            }`}
            onClick={() => setMode('register')}
          >
            Create Workspace
          </button>
          <button
            type="button"
            className={`rounded py-1.5 font-medium transition-colors cursor-pointer ${
              mode === 'login'
                ? 'bg-[var(--color-surface)] text-[var(--color-text)] shadow-xs'
                : 'text-[var(--color-text-muted)]'
            }`}
            onClick={() => setMode('login')}
          >
            Sign In
          </button>
        </div>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3.5">
          {mode === 'register' && (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--color-text)]">
                  Full Name
                </label>
                <Input placeholder="Jane Doe" {...form.register('fullName')} />
                {form.formState.errors.fullName && (
                  <p className="mt-1 text-[11px] text-[var(--color-danger)]">
                    {form.formState.errors.fullName.message}
                  </p>
                )}
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--color-text)]">
                  Organization
                </label>
                <Input placeholder="Acme Cloud" {...form.register('organizationName')} />
                {form.formState.errors.organizationName && (
                  <p className="mt-1 text-[11px] text-[var(--color-danger)]">
                    {form.formState.errors.organizationName.message}
                  </p>
                )}
              </div>
            </>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-text)]">
              Work Email
            </label>
            <Input type="email" placeholder="ops@acme.io" {...form.register('email')} />
            {form.formState.errors.email && (
              <p className="mt-1 text-[11px] text-[var(--color-danger)]">
                {form.formState.errors.email.message}
              </p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--color-text)]">
              Password
            </label>
            <Input type="password" placeholder="At least 8 characters" {...form.register('password')} />
            {form.formState.errors.password && (
              <p className="mt-1 text-[11px] text-[var(--color-danger)]">
                {form.formState.errors.password.message}
              </p>
            )}
          </div>

          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting
              ? 'Working...'
              : mode === 'register'
                ? 'Create Organization & Sign In'
                : 'Sign In'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
