/**
 * Applies one push notification from Microsoft Graph (a message was created, updated or deleted, in any folder) to the
 * stored mailbox and tells the user's open pages.
 *
 *  created: save the full message; new mail in a folder we show is announced (`mail:new`), Inbox mail is analysed.
 *  updated: read state, flags, folder and conversation follow Outlook (a read in Outlook shows in the page at once).
 *  deleted: Outlook also reports a MOVE as a delete from the old folder, so the message is looked up first: if it still
 *           exists it only changed folder; only a message that is really gone is removed.
 *
 * Outlook access and notifications are injected so this can be tested without Outlook.
 */

import Email from '../models/email.js';

/**
 * @param {object} args
 * @param {{ _id: any, email: string, worxstreamUserId: number, outlookInboxFolderId?: string|null }} args.account
 * @param {'created'|'updated'|'deleted'} args.changeType
 * @param {string} args.messageId
 * @param {{ getMeta: (id: string) => Promise<object|null>, getFull: (id: string) => Promise<object|null>, enqueueEnrichment: (docs: object[]) => Promise<void>, notifyNew: (doc: object) => void, notify: (event: string, payload: object) => void }} args.deps
 * @returns {Promise<{ action: string }>}
 */
export async function applyMessageChange({ account, changeType, messageId, deps }) {
  const email = account.email;
  const filter = { id: messageId, email };

  if (changeType === 'created') {
    const full = await deps.getFull(messageId);
    if (!full) return { action: 'ignored' };
    const existed = Boolean(await Email.exists(filter));
    const folder = full.folder || account.outlookInboxFolderId || 'inbox';
    const saved = await Email.findOneAndUpdate(
      filter,
      {
        $set: {
          id: full.id, userId: account.userId, email, folder,
          from: full.from || '', to: full.to || '', cc: full.cc || '', bcc: full.bcc || '',
          subject: full.subject || '(No Subject)', content: full.content || '',
          preview: (full.content || '').replace(/<[^>]+>/g, '').slice(0, 200),
          timestamp: full.timestamp ? new Date(full.timestamp) : new Date(),
          read: Boolean(full.read), important: Boolean(full.important), flagged: Boolean(full.flagged),
          conversationId: full.conversationId || '', hasAttachments: Boolean(full.hasAttachments),
          updatedAt: new Date(),
        },
        $setOnInsert: { isProcessed: false },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    if (existed) return { action: 'duplicate' }; // Graph can deliver the same notification twice
    // Only Inbox mail is analysed; mail in other folders (Sent, Drafts, ...) is just kept in step.
    if (account.outlookInboxFolderId && folder === account.outlookInboxFolderId) {
      try {
        await deps.enqueueEnrichment([saved]);
      } catch (err) {
        console.error(`❌ Failed to enqueue enrichment for ${saved.id}:`, err.message);
      }
    }
    deps.notifyNew(saved);
    return { action: 'created' };
  }

  const meta = await deps.getMeta(messageId);

  if (changeType === 'updated') {
    if (!meta) return applyMessageChange({ account, changeType: 'deleted', messageId, deps });
    const before = await Email.findOne(filter).lean();
    if (!before) return { action: 'unknown' }; // not stored: the next sync will bring it in
    await Email.updateOne(filter, {
      $set: {
        read: meta.read, important: meta.important, flagged: meta.flagged, folder: meta.folder || before.folder,
        conversationId: meta.conversationId, hasAttachments: meta.hasAttachments, subject: meta.subject, updatedAt: new Date(),
      },
    });
    if (!before.read && meta.read) deps.notify('mail:markedRead', { messageId });
    if (before.important !== meta.important) deps.notify('mail:importantMarked', { messageId, flag: meta.important });
    return { action: 'updated' };
  }

  if (changeType === 'deleted') {
    if (meta) {
      // Still there: it was moved. Follow it instead of deleting.
      await Email.updateOne(filter, { $set: { folder: meta.folder, updatedAt: new Date() } });
      return { action: 'moved' };
    }
    const res = await Email.deleteOne(filter);
    if (res.deletedCount) deps.notify('mail:deleted', { messageId });
    return { action: res.deletedCount ? 'deleted' : 'unknown' };
  }
  return { action: 'ignored' };
}
