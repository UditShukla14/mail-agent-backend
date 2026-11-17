import emailEnrichmentService from './emailEnrichment.js';
import { debug } from '../../utils/logger.js';

const CHUNK_SIZE = 5; // analyses run this many at a time (the LLM client also caps concurrency)

/**
 * Analyse one email and report progress through `emit` (a socket emitter, or nothing).
 * Retrying across the model family happens inside the Raven agent, so a failure here is final: it is saved
 * on the message by the enrichment service and the user can press Re-analyze.
 */
async function processEmail(email, emit) {
  const send = (payload) => {
    try {
      emit?.('mail:enrichmentStatus', { messageId: email.id, ...payload });
    } catch (error) {
      debug(`📡 Could not emit status for ${email.id}: ${error.message}`); // the result is saved either way
    }
  };

  send({ status: 'analyzing', message: 'Analyzing email content...' });
  try {
    const updated = await emailEnrichmentService.enrichEmail(email, false);
    // Safety net: a result without an analysis is reported as an error rather than as completed.
    if (!updated?.aiMeta?.summary || updated.aiMeta.error) {
      send({ status: 'error', message: 'Not analysed', error: true });
      return { success: false, error: new Error('Not analysed') };
    }
    send({ status: 'completed', message: 'Email analysis completed', aiMeta: updated.aiMeta, email: updated });
    return { success: true, data: updated };
  } catch (error) {
    send({ status: 'error', message: error.message, error: true });
    return { success: false, error };
  }
}

/** Analyse a batch of emails a few at a time. */
export async function processEnrichmentBatch(emails, emit = null) {
  const results = [];
  for (let i = 0; i < emails.length; i += CHUNK_SIZE) {
    const chunk = emails.slice(i, i + CHUNK_SIZE);
    results.push(...(await Promise.all(chunk.map((email) => processEmail(email, emit)))));
  }
  const successful = results.filter((r) => r.success).map((r) => r.data);
  const failed = results.filter((r) => !r.success).map((r) => r.error);
  console.log(`✅ Analysis batch finished: ${successful.length} done, ${failed.length} failed`);
  return { successful, failed };
}
