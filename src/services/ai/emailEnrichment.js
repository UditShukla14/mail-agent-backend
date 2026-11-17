import Email from '../../models/email.js';
import User from '../../models/User.js';
import EmailAccount from '../../models/EmailAccount.js';
import { analyzeEmail, AgentError } from '../../agents/index.js';
import { ravenBilling } from '../billing/ravenBilling.js';
import { companyOf } from '../companies.js';
import { debug } from '../../utils/logger.js';

/**
 * Stores the Raven agent's result on the message and tells the owner's open page about it.
 * (The AI itself lives in src/agents/raven; this class only does the mail-side bookkeeping.)
 */
class EmailEnrichmentService {
  constructor() {
    this.io = null;
  }

  setIO(io) {
    this.io = io;
  }

  /** Tell the owner's connected page how this message's analysis is going. */
  async notify(userId, payload) {
    const user = await User.findById(userId);
    const socket = user ? this.findUserSocket(user.worxstreamUserId) : null;
    if (socket) socket.emit('mail:enrichmentStatus', payload);
  }

  async enrichEmail(email, forceReprocess = false) {
    if (!email || !email.email || !email.userId) {
      throw new Error('Invalid email object - missing required fields');
    }
    if (!forceReprocess && email.isProcessed && email.aiMeta?.summary) {
      debug('⏭️ Email already enriched, skipping:', email.id);
      return email;
    }

    try {
      // Raven is a separately subscribed and billed app: only analyse for a company that has it and has credit.
      const user = await User.findById(email.userId);
      const companyId = companyOf(user);
      const access = await ravenBilling.checkAccess(companyId);
      if (!access.allowed) throw new AgentError(access.message || 'Raven is not available for this company.', 'NOT_ENTITLED', access);

      await this.notify(email.userId, { messageId: email.id, status: 'analyzing', message: 'Analyzing email content...' });

      const account = await EmailAccount.findOne({ userId: email.userId, email: email.email });
      // Every model call is reported to the hub for pricing and the company's Raven wallet, including a retried one.
      const onCall = (call) => ravenBilling.reportUsage({ ...call, companyId, userId: user?.worxstreamUserId, requestId: String(email._id) });
      const { result, meta } = await analyzeEmail(email, account?.categories || [], { onCall });
      debug(`🤖 ${email.id} analysed by ${meta.model}${meta.fellBack ? ' (fallback model)' : ''}`);

      const aiMeta = { ...result, enrichedAt: new Date().toISOString(), version: '1.0', error: null };
      const updated = await Email.findByIdAndUpdate(email._id, { $set: { aiMeta, isProcessed: true } }, { new: true });
      await this.notify(email.userId, { messageId: email.id, status: 'completed', message: 'Analysis complete', aiMeta, email: updated });
      return updated;
    } catch (error) {
      // Not subscribed / out of credit: nothing was analysed and nothing is saved on the message; tell the user why.
      if (error instanceof AgentError && error.code === 'NOT_ENTITLED') {
        await this.notify(email.userId, { messageId: email.id, status: 'error', message: error.message, error: true });
        throw error;
      }

      // Categories are a prerequisite, not a failure: wait for the user to create them.
      if (error instanceof AgentError && error.code === 'NO_CONTEXT') {
        await Email.findByIdAndUpdate(email._id, {
          $set: { 'aiMeta.error': 'Waiting for user to create categories', 'aiMeta.enrichedAt': new Date().toISOString(), 'aiMeta.version': '1.0', isProcessed: false },
        });
        await this.notify(email.userId, { messageId: email.id, status: 'waiting', message: 'Please create email categories first to enable AI analysis' });
        throw error;
      }

      console.error(`❌ Email analysis failed for ${email.id}: ${error.message}`);
      await Email.findByIdAndUpdate(email._id, {
        $set: { 'aiMeta.error': error.message, 'aiMeta.enrichedAt': new Date().toISOString(), 'aiMeta.version': '1.0', isProcessed: false },
      });
      await this.notify(email.userId, { messageId: email.id, status: 'error', message: error.message });
      throw error;
    }
  }

  // Register a socket for unified access
  registerSocket(socket) {
    if (!this.io) {
      console.warn('⚠️ IO not set, cannot register socket');
      return;
    }
    
    // Socket is already registered with IO, just log for tracking
    debug(`📡 Socket registered for user: ${socket.worxstreamUserId} with socket ID: ${socket.id}`);
    
    // Verify the socket is actually in the IO sockets collection
    const sockets = Array.from(this.io.sockets.sockets.values());
    const foundSocket = sockets.find(s => s.id === socket.id);
    if (foundSocket) {
      debug(`✅ Socket ${socket.id} confirmed in IO sockets collection`);
    } else {
      debug(`❌ Socket ${socket.id} not found in IO sockets collection`);
    }
  }

  // Helper method to find a user's socket
  findUserSocket(worxstreamUserId) {
    if (!this.io) {
      debug('❌ IO not available for socket lookup');
      return null;
    }
    
    // Get all connected sockets
    const sockets = Array.from(this.io.sockets.sockets.values());
    debug(`🔍 Looking for socket for user ${worxstreamUserId}, total sockets: ${sockets.length}`);
    
    // Find the socket that has this worxstreamUserId (handle both string and number types)
    const userSocket = sockets.find(socket => {
      const socketUserId = socket.worxstreamUserId;
      const matches = String(socketUserId) === String(worxstreamUserId);
      if (matches) {
        debug(`✅ Found socket for user ${worxstreamUserId}: ${socket.id}`);
      }
      return matches;
    });
    
    if (!userSocket) {
      debug(`❌ No socket found for user ${worxstreamUserId}`);
      // Log all available sockets for debugging
      sockets.forEach(socket => {
        debug(`📡 Socket ${socket.id}: worxstreamUserId = ${socket.worxstreamUserId}, connected = ${socket.connected}`);
      });
    }
    
    return userSocket;
  }

  // Unregister a socket when it disconnects
  unregisterSocket(socket) {
    if (!this.io) {
      debug('⚠️ IO not available for socket unregistration');
      return;
    }
    
    debug(`📡 Unregistering socket: ${socket.id} for user: ${socket.worxstreamUserId}`);
    
    // The socket is automatically removed from IO when it disconnects
    // This method is mainly for logging and cleanup purposes
    if (socket.worxstreamUserId) {
      debug(`🧹 Socket cleanup completed for user: ${socket.worxstreamUserId}`);
    }
  }
}

const service = new EmailEnrichmentService();
export default service;
