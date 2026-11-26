import { zodResolver } from '@hookform/resolvers/zod';
import { AppDialog, Button, Input } from '@mail/ui';
import { Bold, Clock, Italic, List, Paperclip, Send, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import type { WebmailApiClient } from '../lib/api.js';

const composeSchema = z.object({
  to: z.string().min(3, 'At least one recipient is required'),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().min(1, 'Subject is required'),
  body: z.string().min(1, 'Message body is required'),
  scheduledAt: z.string().optional(),
});

type ComposeFormValues = z.infer<typeof composeSchema>;

interface StagedAttachment {
  filename: string;
  contentType: string;
  contentBase64: string;
  sizeBytes: number;
}

export interface ComposeInitialState {
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  inReplyToThreadId?: string;
}

export function ComposeDialog({
  open,
  onOpenChange,
  api,
  initial,
  signatureHtml,
  signatureEnabled,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: WebmailApiClient;
  initial?: ComposeInitialState;
  signatureHtml?: string;
  signatureEnabled?: boolean;
  onSent: () => void;
}) {
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [isHtmlMode, setIsHtmlMode] = useState(true);
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [draftId, setDraftId] = useState<string | undefined>(undefined);
  const fileRef = useRef<HTMLInputElement>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ComposeFormValues>({
    resolver: zodResolver(composeSchema),
    defaultValues: {
      to: initial?.to ?? '',
      cc: initial?.cc ?? '',
      bcc: '',
      subject: initial?.subject ?? '',
      body: initial?.body ?? '',
      scheduledAt: '',
    },
  });

  useEffect(() => {
    if (open) {
      reset({
        to: initial?.to ?? '',
        cc: initial?.cc ?? '',
        bcc: '',
        subject: initial?.subject ?? '',
        body: initial?.body ?? '',
        scheduledAt: '',
      });
      setAttachments([]);
      setDraftId(undefined);
    }
  }, [open, initial, reset]);

  const watched = watch();

  // Debounced draft autosave
  useEffect(() => {
    if (!open || (!watched.subject && !watched.body && !watched.to)) return;
    const timer = setTimeout(() => {
      const splitList = (v?: string) =>
        (v ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      void api
        .saveDraft({
          ...(draftId ? { id: draftId } : {}),
          to: splitList(watched.to),
          cc: splitList(watched.cc),
          bcc: splitList(watched.bcc),
          subject: watched.subject ?? '',
          htmlBody: isHtmlMode ? `<p>${watched.body ?? ''}</p>` : '',
          textBody: watched.body ?? '',
        })
        .then((res) => setDraftId(res.draft.id))
        .catch(() => undefined);
    }, 1500);
    return () => clearTimeout(timer);
  }, [open, watched.to, watched.cc, watched.bcc, watched.subject, watched.body, isHtmlMode, draftId, api]);

  const handleFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      setAttachments((prev) => [
        ...prev,
        {
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          contentBase64: btoa(bin),
          sizeBytes: file.size,
        },
      ]);
    }
  };

  const applyFormat = (tag: 'b' | 'i' | 'li') => {
    const current = watched.body ?? '';
    const snippet =
      tag === 'b' ? '<strong>bold text</strong>' : tag === 'i' ? '<em>italic text</em>' : '\n<ul><li>Item</li></ul>';
    setValue('body', `${current}${snippet}`);
  };

  const onSubmit = async (values: ComposeFormValues) => {
    const splitEmails = (raw?: string) =>
      (raw ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    const sigBlock = signatureEnabled && signatureHtml ? `\n${signatureHtml}` : '';
    const htmlBody = isHtmlMode ? `<div>${values.body.replace(/\n/g, '<br/>')}</div>${sigBlock}` : '';

    await api.sendMessage({
      to: splitEmails(values.to),
      cc: splitEmails(values.cc),
      bcc: splitEmails(values.bcc),
      subject: values.subject,
      htmlBody,
      textBody: values.body,
      ...(initial?.inReplyToThreadId ? { inReplyToThreadId: initial.inReplyToThreadId } : {}),
      ...(values.scheduledAt ? { scheduledAt: new Date(values.scheduledAt).toISOString() } : {}),
      attachments: attachments.map(({ filename, contentType, contentBase64 }) => ({
        filename,
        contentType,
        contentBase64,
      })),
    });

    toast.success(values.scheduledAt ? 'Email scheduled' : 'Email sent');
    onOpenChange(false);
    onSent();
  };

  return (
    <AppDialog open={open} onOpenChange={onOpenChange} title="New message" maxWidthClass="max-w-2xl">
      <form
        onSubmit={handleSubmit(onSubmit)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void handleFiles(e.dataTransfer.files);
        }}
        className="space-y-3 text-xs"
      >
        <div>
          <div className="flex items-center gap-2">
            <Input {...register('to')} placeholder="To (comma-separated)" />
            <Button type="button" size="sm" variant="ghost" onClick={() => setShowCcBcc((v) => !v)}>
              Cc/Bcc
            </Button>
          </div>
          {errors.to && <p className="mt-1 text-[var(--color-danger)]">{errors.to.message}</p>}
        </div>

        {showCcBcc && (
          <div className="grid grid-cols-2 gap-2">
            <Input {...register('cc')} placeholder="Cc" />
            <Input {...register('bcc')} placeholder="Bcc" />
          </div>
        )}

        <div>
          <Input {...register('subject')} placeholder="Subject" />
          {errors.subject && (
            <p className="mt-1 text-[var(--color-danger)]">{errors.subject.message}</p>
          )}
        </div>

        <div className="flex items-center justify-between border border-[var(--color-border)] rounded-t-md bg-[var(--color-surface-muted)] px-2 py-1">
          <div className="flex items-center gap-1">
            <Button type="button" size="icon" variant="ghost" onClick={() => applyFormat('b')} title="Bold">
              <Bold className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" size="icon" variant="ghost" onClick={() => applyFormat('i')} title="Italic">
              <Italic className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" size="icon" variant="ghost" onClick={() => applyFormat('li')} title="List">
              <List className="h-3.5 w-3.5" />
            </Button>
          </div>
          <button
            type="button"
            onClick={() => setIsHtmlMode((v) => !v)}
            className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer"
          >
            Mode: {isHtmlMode ? 'Rich HTML' : 'Plain text'}
          </button>
        </div>

        <textarea
          {...register('body')}
          rows={9}
          placeholder="Write your message or drag & drop attachments here..."
          className="w-full -mt-3 rounded-b-md border border-t-0 border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm text-[var(--color-text)] focus:outline-none"
        />
        {errors.body && <p className="text-[var(--color-danger)]">{errors.body.message}</p>}

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((att, idx) => (
              <span
                key={`${att.filename}-${idx}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-1"
              >
                <Paperclip className="h-3 w-3" />
                {att.filename} ({Math.max(1, Math.round(att.sizeBytes / 1024))} KB)
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== idx))}
                  className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)] cursor-pointer"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[var(--color-border)]">
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => void handleFiles(e.target.files)}
            />
            <Button type="button" size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
              <Upload className="h-3.5 w-3.5" /> Attach
            </Button>
            <div className="inline-flex items-center gap-1 text-[var(--color-text-muted)]">
              <Clock className="h-3.5 w-3.5" />
              <input
                type="datetime-local"
                {...register('scheduledAt')}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px]"
                title="Optional scheduled send time"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            {draftId && <span className="text-[11px] text-[var(--color-text-muted)]">Draft saved</span>}
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Discard
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              <Send className="h-3.5 w-3.5" />
              {watched.scheduledAt ? 'Schedule' : 'Send'}
            </Button>
          </div>
        </div>
      </form>
    </AppDialog>
  );
}
