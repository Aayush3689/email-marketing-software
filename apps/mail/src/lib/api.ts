export interface FolderDto {
  id: string;
  name: string;
  kind: 'system' | 'custom';
  unreadCount: number;
  totalCount: number;
}

export interface ThreadSummaryDto {
  threadId: string;
  subject: string;
  snippet: string;
  participants: Array<{ name: string; address: string }>;
  lastMessageAt: string;
  messageCount: number;
  unreadCount: number;
  isStarred: boolean;
  isImportant: boolean;
  hasAttachments: boolean;
  labels: string[];
  folder: string;
}

export interface MessageDto {
  id: string;
  threadId: string;
  folder: string;
  from: { name: string; address: string };
  to: Array<{ name: string; address: string }>;
  cc: Array<{ name: string; address: string }>;
  subject: string;
  snippet: string;
  htmlBody: string;
  textBody: string;
  receivedAt: string;
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  labels: string[];
  attachments: Array<{
    partId: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    isInline: boolean;
  }>;
}

export interface ContactDto {
  id: string;
  name: string;
  email: string;
  company?: string;
}

export interface MailboxSettingsDto {
  signatureHtml: string;
  signatureEnabled: boolean;
  displayName: string;
  quotaBytes: number;
  usedBytes: number;
}

const API_BASE = '/mail/v1';

export class WebmailApiClient {
  constructor(private readonly getToken: () => string | null) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = this.getToken();
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  login(email: string, password: string) {
    return this.request<{ token: string; mailboxEmail: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  }

  getFolders() {
    return this.request<{ folders: FolderDto[] }>('/folders');
  }

  listThreads(params: Record<string, string | boolean | number | undefined>) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    return this.request<{ threads: ThreadSummaryDto[]; total: number }>(`/threads?${qs.toString()}`);
  }

  getThread(threadId: string) {
    return this.request<{ threadId: string; messages: MessageDto[] }>(`/threads/${threadId}`);
  }

  patchMessage(
    id: string,
    patch: {
      isRead?: boolean;
      isStarred?: boolean;
      isImportant?: boolean;
      folder?: string;
      addLabel?: string;
      removeLabel?: string;
    }
  ) {
    return this.request<{ message: MessageDto }>(`/messages/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  saveDraft(draft: {
    id?: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    htmlBody: string;
    textBody: string;
  }) {
    return this.request<{ draft: MessageDto }>('/drafts', {
      method: 'POST',
      body: JSON.stringify(draft),
    });
  }

  sendMessage(payload: {
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    htmlBody: string;
    textBody: string;
    inReplyToThreadId?: string;
    scheduledAt?: string;
    attachments?: Array<{ filename: string; contentType: string; contentBase64: string }>;
  }) {
    return this.request<{ message: MessageDto }>('/messages/send', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  listContacts() {
    return this.request<{ contacts: ContactDto[] }>('/contacts');
  }

  createContact(input: { name: string; email: string; company?: string }) {
    return this.request<{ contact: ContactDto }>('/contacts', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  getSettings() {
    return this.request<{ settings: MailboxSettingsDto }>('/settings');
  }

  updateSettings(patch: { signatureHtml?: string; signatureEnabled?: boolean; displayName?: string }) {
    return this.request<{ settings: MailboxSettingsDto }>('/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
  }

  async downloadAttachment(messageId: string, partId: string, filename: string): Promise<void> {
    const token = this.getToken();
    const res = await fetch(
      `${API_BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(partId)}`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} }
    );
    if (!res.ok) {
      throw new Error(`Attachment download failed (${res.status})`);
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }
}
