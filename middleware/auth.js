import { verifyBearerToken, DEV_USER, isDevFallbackAllowed } from '../utils/authVerify.js';

const bearerFrom = (req) => {
  const header = req.headers.authorization;
  return header && header.startsWith('Bearer ') ? header.substring(7).trim() : null;
};

/**
 * Authentication middleware. The caller's identity comes only from verifying the bearer token with worXstream;
 * the X-User-Info header sent by older clients is ignored.
 */
export const authenticateUser = async (req, res, next) => {
  const token = bearerFrom(req);
  if (!token) {
    return res.status(401).json({ success: false, error: 'Authorization token required', code: 'TOKEN_MISSING' });
  }

  try {
    const { user, reason } = await verifyBearerToken(token);
    if (user) {
      req.user = user;
      req.token = token;
      return next();
    }
    if (isDevFallbackAllowed() && reason !== 'invalid') {
      req.user = { ...DEV_USER };
      req.token = token;
      return next();
    }
    if (reason === 'unavailable') {
      return res.status(503).json({ success: false, error: 'Authentication service unavailable', code: 'AUTH_SERVICE_UNAVAILABLE' });
    }
    return res.status(401).json({ success: false, error: 'Invalid or expired token', code: 'TOKEN_INVALID' });
  } catch (error) {
    console.error('Authentication error:', error.message);
    return res.status(500).json({ success: false, error: 'Authentication service error', code: 'AUTH_SERVICE_ERROR' });
  }
};

/** For routes that work with or without a signed-in user: req.user is null unless the token verifies. */
export const optionalAuth = async (req, res, next) => {
  req.user = null;
  req.token = null;
  const token = bearerFrom(req);
  if (!token) return next();
  try {
    const { user } = await verifyBearerToken(token);
    if (user) {
      req.user = user;
      req.token = token;
    }
  } catch (error) {
    console.error('Optional authentication error:', error.message);
  }
  next();
};

// TODO: Re-implement validateMailAccess when subscription system is ready
// export const validateMailAccess = async (req, res, next) => {
//   // Subscription validation logic will go here
//   return next();
// }; 