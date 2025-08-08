import { worxstreamApi } from '../services/worxstreamApi.js';

// Development fallback user creation
const createDevUser = (token) => {
  // Extract user ID from token (assuming token contains user info)
  // For development, we'll use a hash of the token as user ID
  const userId = Math.abs(token.split('').reduce((a, b) => {
    a = ((a << 5) - a) + b.charCodeAt(0);
    return a & a;
  }, 0)) % 10000; // Generate a number between 0-9999
  
  return {
    id: userId,
    name: 'Development User',
    email: `dev-user-${userId}@mailagent.com`,
    email_verified_at: new Date().toISOString(),
    status: 'active',
    is_admin: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
};

// Authentication middleware for worXstream integration
export const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Authorization token required',
        code: 'TOKEN_MISSING'
      });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    
    // Check if user info is provided in headers (from frontend)
    const userInfoHeader = req.headers['x-user-info'];
    if (userInfoHeader) {
      try {
        const userInfo = JSON.parse(userInfoHeader);
        req.user = userInfo;
        req.token = token;
        return next();
      } catch (error) {
        console.error('Error parsing user info:', error);
        // Silently handle parsing error
      }
    }
    
    // Try to verify token with worXstream backend
    const verificationResult = await worxstreamApi.verifyUserToken(token);
    
    if (verificationResult.success) {
      // Successfully verified with worXstream
      req.user = verificationResult.user;
      req.token = token;
    } else {
      // worXstream API not available, use development fallback
      if (process.env.NODE_ENV === 'development') {
        req.user = createDevUser(token);
        req.token = token;
      } else {
        return res.status(401).json({
          success: false,
          error: verificationResult.error || 'Invalid or expired token',
          code: 'TOKEN_INVALID'
        });
      }
    }
    
    next();
  } catch (error) {
    // In development mode, fallback to dev user
    if (process.env.NODE_ENV === 'development') {
      const token = req.headers.authorization?.substring(7) || 'dev-token';
      req.user = createDevUser(token);
      req.token = token;
      return next();
    }
    
    return res.status(500).json({
      success: false,
      error: 'Authentication service error',
      code: 'AUTH_SERVICE_ERROR'
    });
  }
};

// Optional authentication middleware (for routes that can work with or without auth)
export const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // No token provided, continue without authentication
      req.user = null;
      req.token = null;
      return next();
    }

    const token = authHeader.substring(7);
    
    // Try to verify token with worXstream backend
    const verificationResult = await worxstreamApi.verifyUserToken(token);
    
    if (verificationResult.success) {
      req.user = verificationResult.user;
      req.token = token;
    } else {
      // In development mode, use fallback
      if (process.env.NODE_ENV === 'development') {
        req.user = createDevUser(token);
        req.token = token;
      } else {
        req.user = null;
        req.token = null;
      }
    }
    
    next();
  } catch (error) {
    // In development mode, use fallback
    if (process.env.NODE_ENV === 'development') {
      const token = req.headers.authorization?.substring(7) || 'dev-token';
      req.user = createDevUser(token);
      req.token = token;
    } else {
      // Continue without authentication on error
      req.user = null;
      req.token = null;
    }
    
    next();
  }
};

// TODO: Re-implement validateMailAccess when subscription system is ready
// export const validateMailAccess = async (req, res, next) => {
//   // Subscription validation logic will go here
//   return next();
// }; 