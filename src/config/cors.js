// CORS / Socket.IO origin policy for the worXstream web app.
export const allowedOrigins = [
  'http://localhost:4173', // worXstream web app (local dev)
  'https://app.worxstream.ai', // worXstream web app (production)
  // Anything else, comma-separated, e.g. CORS_ORIGINS=https://staging.example.com
  ...(process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean),
];

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
const HEADERS = ['Content-Type', 'Authorization', 'X-User-Info'];

export const corsOptions = {
  origin(origin, callback) {
    // No origin: non-browser clients (server-to-server, curl)
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  methods: METHODS,
  allowedHeaders: HEADERS,
  credentials: true,
  optionsSuccessStatus: 204,
};

export const socketCorsOptions = {
  origin: allowedOrigins,
  methods: METHODS,
  credentials: true,
  allowedHeaders: HEADERS,
};
