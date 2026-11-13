/** Replace cid: image references with the inline image data, and hide the ones that cannot be shown. */
export function embedInlineImages(html, attachments = []) {
  let out = html || '';
  for (const a of attachments) {
    if (a.contentId && a.contentBytes) {
      const cid = `cid:${a.contentId}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(cid, 'gi'), `data:${a.contentType};base64,${a.contentBytes}`);
    }
  }
  return out.replace(
    /<img[^>]*src=["']cid:[^"']*["'][^>]*>/gi,
    '<div style="color: #666; font-style: italic; padding: 10px; border: 1px dashed #ccc; margin: 10px 0;">[Inline image not available]</div>',
  );
}
