import express from 'express';
import { processOutlookNotifications } from '../services/outlookWebhookProcessor.js';

const router = express.Router();

/**
 * Microsoft Graph change + lifecycle notifications for Outlook mail.
 * Public endpoint — Graph validates via validationToken handshake; we verify clientState on real events.
 */
router.post('/outlook/mail', async (req, res) => {
  // Subscription validation handshake
  if (req.query.validationToken) {
    const token = Array.isArray(req.query.validationToken)
      ? req.query.validationToken[0]
      : req.query.validationToken;

    console.log('📡 Graph webhook validation request received');
    res.set('Content-Type', 'text/plain');
    return res.status(200).send(token);
  }

  const notifications = req.body?.value;
  if (!Array.isArray(notifications) || notifications.length === 0) {
    return res.status(202).send();
  }

  // Acknowledge immediately; process async so Graph does not retry
  res.status(202).send();

  setImmediate(() => {
    processOutlookNotifications(notifications).catch((err) => {
      console.error('❌ Outlook webhook batch failed:', err.message);
    });
  });
});

export default router;
