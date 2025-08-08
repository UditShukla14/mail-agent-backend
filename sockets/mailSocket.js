// sockets/mailSocket.js
import { initCoreSocketHandlers } from './coreSocketHandlers.js';
import { initMailOperationsHandlers } from './mailOperationsHandlers.js';
import { initMailManagementHandlers } from './mailManagementHandlers.js';
import { initEnrichmentHandlers } from './enrichmentHandlers.js';

export const initMailSocket = (socket, io) => {
  console.log('🔌 Initializing mail socket handlers for:', socket.id);

  // Initialize all socket handlers
  initCoreSocketHandlers(socket, io);
  initMailOperationsHandlers(socket, io);
  initMailManagementHandlers(socket, io);
  initEnrichmentHandlers(socket, io);

  console.log('✅ All mail socket handlers initialized');
}; 
