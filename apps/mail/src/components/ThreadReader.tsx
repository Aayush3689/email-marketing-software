import { Badge, Button, Card } from '@mail/ui';
import {
  Archive,
  Download,
  Forward,
  MailOpen,
  Paperclip,
  Printer,
  Reply,
  ReplyAll,
  ShieldAlert,
  Star,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import type { MessageDto } from '../lib/api.js';
import { sanitizeEmailHtml } from '../lib/sanitize.js';

export function ThreadReader({
  messages,
  onPatch,
  onReply,
  onDownloadAttachment,
}: {
  messages: MessageDto[];
  onPatch: (
    id: string,
    patch: { isRead?: boolean; isStarred?: boolean; folder?: string }
  ) => void;
  onReply: (mode: 'reply' | 'replyAll' | 'forward', msg: MessageDto) => void;
  onDownloadAttachment: (messageId: string, partId: string, filename: string) => void;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(messages.length > 0 ? [messages[messages.length - 1]!.id] : [])
  );

  const latest = messages[messages.length - 1];
  if (!latest) return null;

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-5 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-base font-semibold truncate">{latest.subject}</h2>
          {latest.labels.map((lbl) => (
            <Badge key={lbl} tone="brand">
              {lbl}
            </Badge>
          ))}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="icon"
            variant="ghost"
            title="Archive (e)"
            onClick={() => onPatch(latest.id, { folder: 'archive' })}
          >
            <Archive className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title="Report spam"
            onClick={() => onPatch(latest.id, { folder: 'spam' })}
          >
            <ShieldAlert className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title="Delete"
            onClick={() => onPatch(latest.id, { folder: 'trash' })}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title={latest.isRead ? 'Mark unread' : 'Mark read'}
            onClick={() => onPatch(latest.id, { isRead: !latest.isRead })}
          >
            <MailOpen className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" title="Print" onClick={() => window.print()}>
            <Printer className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-3">
        {messages.map((msg) => {
          const isOpen = expandedIds.has(msg.id) || messages.length === 1;
          const sanitized = msg.htmlBody ? sanitizeEmailHtml(msg.htmlBody) : '';

          return (
            <Card key={msg.id} className="overflow-hidden">
              <div
                onClick={() => toggleExpand(msg.id)}
                className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer hover:bg-[var(--color-surface-muted)]"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium truncate">
                      {msg.from.name || msg.from.address}
                    </span>
                    <span className="text-xs text-[var(--color-text-muted)] truncate">
                      &lt;{msg.from.address}&gt;
                    </span>
                  </div>
                  {isOpen ? (
                    <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
                      To: {msg.to.map((t) => t.address).join(', ')}
                      {msg.cc.length > 0 && ` · Cc: ${msg.cc.map((c) => c.address).join(', ')}`}
                    </div>
                  ) : (
                    <div className="text-xs text-[var(--color-text-muted)] truncate mt-0.5">
                      {msg.snippet}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0 text-xs text-[var(--color-text-muted)]">
                  <span>{new Date(msg.receivedAt).toLocaleString()}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPatch(msg.id, { isStarred: !msg.isStarred });
                    }}
                    className="p-1 rounded hover:bg-[var(--color-surface-muted)] cursor-pointer"
                    aria-label="Toggle star"
                  >
                    <Star
                      className={`h-4 w-4 ${
                        msg.isStarred ? 'fill-amber-400 text-amber-400' : ''
                      }`}
                    />
                  </button>
                </div>
              </div>

              {isOpen && (
                <div className="border-t border-[var(--color-border)] px-4 py-4">
                  {sanitized ? (
                    <div
                      className="prose prose-sm max-w-none text-sm leading-relaxed text-[var(--color-text)]"
                      dangerouslySetInnerHTML={{ __html: sanitized }}
                    />
                  ) : (
                    <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-[var(--color-text)]">
                      {msg.textBody}
                    </pre>
                  )}

                  {msg.attachments.length > 0 && (
                    <div className="mt-4 pt-3 border-t border-[var(--color-border)] flex flex-wrap gap-2">
                      {msg.attachments.map((att) => (
                        <button
                          key={att.partId}
                          type="button"
                          onClick={() => onDownloadAttachment(msg.id, att.partId, att.filename)}
                          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-1.5 text-xs hover:border-[var(--color-border-strong)] cursor-pointer"
                        >
                          <Paperclip className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
                          <span>{att.filename}</span>
                          <span className="text-[var(--color-text-muted)]">
                            ({Math.max(1, Math.round(att.sizeBytes / 1024))} KB)
                          </span>
                          <Download className="h-3 w-3 ml-1" />
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => onReply('reply', msg)}>
                      <Reply className="h-3.5 w-3.5" /> Reply
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => onReply('replyAll', msg)}>
                      <ReplyAll className="h-3.5 w-3.5" /> Reply all
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => onReply('forward', msg)}>
                      <Forward className="h-3.5 w-3.5" /> Forward
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
