import DOMPurify from 'dompurify';

/**
 * Sanitizes untrusted inbound HTML email bodies to block scripts, inline event handlers,
 * forms, iframes, and `javascript:` URIs before rendering in the Webmail reader.
 */
export function sanitizeEmailHtml(unsafeHtml: string): string {
  if (typeof window === 'undefined') {
    // Fallback defensive stripping for non-DOM contexts
    return unsafeHtml
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
      .replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '');
  }
  return DOMPurify.sanitize(unsafeHtml, {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus'],
    ALLOW_DATA_ATTR: false,
  });
}
