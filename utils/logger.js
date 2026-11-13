// Simple logger utility.
// Chatter (per-mail, per-request, per-timer lines) goes through debug() and is silent unless LOG_LEVEL=debug.
// Real events (errors, warnings, one-line operational facts) use console.error / console.warn / console.log directly.
const DEBUG = () => process.env.LOG_LEVEL === 'debug';

/** console.log that only prints when LOG_LEVEL=debug. */
export const debug = (...args) => {
  if (DEBUG()) console.log(...args);
};

const logger = {
  info: (message) => {
    console.log(`ℹ️ ${message}`);
  },
  error: (message) => {
    console.error(`❌ ${message}`);
  },
  warn: (message) => {
    console.warn(`⚠️ ${message}`);
  },
  debug: (message) => {
    if (DEBUG()) console.debug(`🔍 ${message}`);
  }
};

export { logger };
