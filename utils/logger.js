// Simple logger utility
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
    if (process.env.NODE_ENV === 'development') {
      console.debug(`🔍 ${message}`);
    }
  }
};

export { logger }; 