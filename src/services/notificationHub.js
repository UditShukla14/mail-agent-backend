/**
 * Publishes a notification to the central notification backend (notification-backend). Fire-and-forget.
 * NOTIFICATION_API_URL + NOTIFICATION_SERVICE_KEY (registered as "mail" in the service's SERVICE_KEYS).
 */
export function publishNotification(event, { fetchImpl = fetch } = {}) {
  const base = (process.env.NOTIFICATION_API_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.NOTIFICATION_SERVICE_KEY || '').trim();
  if (!base || !key || !event?.companyId || !event?.userId) return Promise.resolve(false);
  return fetchImpl(`${base}/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Key': key },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(5000),
  })
    .then((res) => res.ok)
    .catch((error) => {
      console.warn('[notification-hub] publish failed:', error.message);
      return false;
    });
}

/** The hub event for one new mail. Exported for tests. */
export function newMailEvent({ companyId, worxstreamUserId, email, message }) {
  const from = message?.from?.name || message?.from?.email || message?.from || 'Unknown sender';
  return {
    companyId,
    userId: worxstreamUserId,
    type: 'mail.new',
    title: String(typeof from === 'string' ? from : 'New mail'),
    body: String(message?.subject || '(no subject)'),
    actionUrl: '/mails',
    data: { account: email, messageId: message?.id, conversationId: message?.conversationId, important: !!message?.important },
    idempotencyKey: message?.id ? `mail:${message.id}` : undefined,
  };
}
