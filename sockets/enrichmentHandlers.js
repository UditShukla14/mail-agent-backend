import Email from '../models/email.js';
import emailEnrichmentService from '../services/emailEnrichment.js';
import enrichmentQueueService from '../services/enrichmentQueueService.js';

export const initEnrichmentHandlers = (socket, io) => {
  // New handler for enriching specific emails
  socket.on('mail:enrichEmails', async ({ worxstreamUserId, email, messageIds }) => {
    try {
      console.log(`🔍 Enriching ${messageIds.length} emails for ${email}`);
      
      // Get the messages that need enrichment
      const messages = await Email.find({ id: { $in: messageIds } });
      
      if (messages.length === 0) {
        console.log('❌ No messages found for enrichment');
        return;
      }

      // Filter out already enriched messages
      const unenrichedMessages = messages.filter(msg => 
        !msg.aiMeta?.enrichedAt || !msg.isProcessed
      );

      if (unenrichedMessages.length === 0) {
        console.log('✅ All messages are already enriched');
        socket.emit('mail:enrichmentStatus', {
          status: 'completed',
          message: 'All messages are already enriched'
        });
        return;
      }

      console.log(`🔄 Starting enrichment for ${unenrichedMessages.length} messages`);

      // Use the enrichment service to process the messages
      await emailEnrichmentService.enrichBatch(unenrichedMessages, socket);

      console.log(`✅ Enrichment completed for ${unenrichedMessages.length} messages`);
    } catch (error) {
      console.error('❌ Error enriching emails:', error);
      socket.emit('mail:error', 'Failed to enrich emails');
    }
  });

  // Retry enrichment for a specific message
  socket.on('mail:retryEnrichment', async ({ worxstreamUserId, email, messageId }) => {
    try {
      console.log(`🔄 Retrying enrichment for message ${messageId}`);
      
      // Find the message in the database
      const message = await Email.findOne({ id: messageId });
      if (!message) {
        socket.emit('mail:error', 'Message not found');
        return;
      }

      // Force re-enrichment by clearing the existing enrichment data
      await Email.findByIdAndUpdate(message._id, {
        $unset: {
          'aiMeta.enrichedAt': 1,
          'aiMeta.error': 1
        },
        $set: {
          isProcessed: false
        }
      });

      // Get the updated message
      const updatedMessage = await Email.findById(message._id);
      
      // Add to enrichment queue for processing
      await enrichmentQueueService.addToQueue([updatedMessage]);

      socket.emit('mail:enrichmentStatus', {
        messageId: messageId,
        status: 'queued',
        message: 'Message queued for re-enrichment'
      });

      console.log(`✅ Message ${messageId} queued for re-enrichment`);
    } catch (error) {
      console.error('❌ Error retrying enrichment:', error);
      socket.emit('mail:error', 'Failed to retry enrichment');
    }
  });
};
