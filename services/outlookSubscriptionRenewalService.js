import {
  renewExpiringSubscriptions,
  backfillMissingSubscriptions
} from './outlookSubscriptionService.js';
import { debug } from '../utils/logger.js';

class OutlookSubscriptionRenewalService {
  constructor() {
    this.isRunning = false;
    this.interval = null;
    // Check every 6 hours
    this.checkInterval = 6 * 60 * 60 * 1000;
  }

  start() {
    if (this.isRunning) {
      debug('📡 Outlook subscription renewal service is already running');
      return;
    }

    if (!process.env.OUTLOOK_WEBHOOK_CLIENT_STATE) {
      console.warn('⚠️ Outlook subscription renewal not started — OUTLOOK_WEBHOOK_CLIENT_STATE missing');
      return;
    }

    debug('🚀 Starting Outlook subscription renewal service...');
    this.isRunning = true;

    // Initial renew + backfill (non-blocking)
    this.runCycle();

    this.interval = setInterval(() => {
      this.runCycle();
    }, this.checkInterval);
  }

  stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    debug('🛑 Outlook subscription renewal service stopped');
  }

  async runCycle() {
    try {
      await renewExpiringSubscriptions();
    } catch (err) {
      console.error('❌ Outlook subscription renewal cycle failed:', err.message);
    }
  }

  async backfill() {
    try {
      return await backfillMissingSubscriptions();
    } catch (err) {
      console.error('❌ Outlook subscription backfill failed:', err.message);
      return null;
    }
  }
}

const outlookSubscriptionRenewalService = new OutlookSubscriptionRenewalService();

export default outlookSubscriptionRenewalService;
