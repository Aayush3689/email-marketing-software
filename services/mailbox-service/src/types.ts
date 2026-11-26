export type SystemFolderId =
  | 'inbox'
  | 'starred'
  | 'important'
  | 'sent'
  | 'drafts'
  | 'archive'
  | 'spam'
  | 'trash';

export interface MailboxFolder {
  id: string;
  name: string;
  imapPath: string;
  kind: 'system' | 'custom';
  unreadCount: number;
  totalCount: number;
}

export interface EmailAttachmentMeta {
  partId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  isInline: boolean;
  contentId?: string;
}

export interface MailMessage {
  id: string;
  threadId: string;
  folder: string;
  from: { name: string; address: string };
  to: Array<{ name: string; address: string }>;
  cc: Array<{ name: string; address: string }>;
  bcc: Array<{ name: string; address: string }>;
  subject: string;
  snippet: string;
  htmlBody: string;
  textBody: string;
  receivedAt: string;
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  labels: string[];
  attachments: EmailAttachmentMeta[];
  scheduledAt?: string;
}

export interface MailThreadSummary {
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

export interface ThreadSearchQuery {
  folder?: string;
  label?: string;
  q?: string;
  from?: string;
  to?: string;
  subject?: string;
  dateFrom?: string;
  dateTo?: string;
  hasAttachment?: boolean;
  unreadOnly?: boolean;
  page: number;
  pageSize: number;
}

export interface WebmailContact {
  id: string;
  name: string;
  email: string;
  company?: string;
}

export interface MailboxSettings {
  signatureHtml: string;
  signatureEnabled: boolean;
  displayName: string;
  quotaBytes: number;
  usedBytes: number;
}
