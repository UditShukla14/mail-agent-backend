# Authentication Setup for Mail Agent Backend

## Overview
The mail agent backend now uses secure token-based authentication for socket connections. This document explains how to configure and use the authentication system.

## How It Works

### 1. **Frontend Sends Token**
```javascript
// Frontend sends only the authentication token
socket.connect({
  auth: { token: "eyJhbGciOiJIUzI1NiIs..." }
});
```

### 2. **Backend Verifies Token**
The backend tries multiple verification methods in order:

1. **JWT Verification** (Primary method)
2. **worXstream API Verification** (If configured)
3. **Local Database Verification** (Fallback)
4. **Base64 Decoding** (Development only)

### 3. **User Authentication**
If token is valid, user info is extracted and socket is authenticated.

## Environment Variables

### **Required for Production**
```bash
JWT_SECRET=your-super-secret-jwt-key-here
```

### **Optional: worXstream API Integration**
```bash
WORXSTREAM_API_URL=https://api.worxstream.io
WORXSTREAM_API_TOKEN=your-worxstream-api-token
```

### **Environment**
```bash
NODE_ENV=production  # or development
```

## Installation

### 1. **Install Dependencies**
```bash
npm install jsonwebtoken
```

### 2. **Set Environment Variables**
Create a `.env` file in the backend directory:
```bash
# Required
JWT_SECRET=your-super-secret-jwt-key-here

# Optional
WORXSTREAM_API_URL=https://api.worxstream.io
WORXSTREAM_API_TOKEN=your-worxstream-api-token

# Environment
NODE_ENV=production
```

### 3. **Generate JWT Secret**
For production, generate a strong secret:
```bash
# Option 1: Use openssl
openssl rand -base64 64

# Option 2: Use node
node -e "console.log(require('crypto').randomBytes(64).toString('base64'))"
```

## Token Verification Methods

### **Method 1: JWT Verification (Recommended)**
- **How**: Verifies JWT signature using `JWT_SECRET`
- **Security**: High - cryptographically secure
- **Performance**: Fast
- **Use Case**: Primary authentication method

### **Method 2: worXstream API Verification**
- **How**: Calls external API to verify token
- **Security**: High - verified by trusted service
- **Performance**: Slower (network call)
- **Use Case**: When integrating with existing auth system

### **Method 3: Local Database Verification**
- **How**: Checks token against local user database
- **Security**: Medium - depends on token storage
- **Performance**: Fast
- **Use Case**: Fallback when other methods fail

### **Method 4: Base64 Decoding (Development Only)**
- **How**: Decodes base64-encoded user info
- **Security**: None - easily forgeable
- **Performance**: Fast
- **Use Case**: Development and testing only

## Frontend Integration

### **Update Socket Connection**
```javascript
// OLD (INSECURE)
socket.connect({
  query: { 
    userInfo: JSON.stringify({ id: user.id, email: user.email })
  }
});

// NEW (SECURE)
socket.connect({
  auth: { token: user.authToken }
});
```

### **Token Storage**
```javascript
// Store token securely
localStorage.setItem('authToken', token);

// Retrieve token
const token = localStorage.getItem('authToken');
```

## Security Best Practices

### **1. Use Strong JWT Secrets**
- Minimum 64 characters
- Use cryptographically secure random generation
- Never commit secrets to version control

### **2. Token Expiration**
- Set reasonable expiration times
- Implement token refresh mechanism
- Clear expired tokens

### **3. HTTPS Only**
- Always use HTTPS in production
- Never send tokens over unencrypted connections

### **4. Token Validation**
- Validate token format before sending
- Handle authentication errors gracefully
- Log failed authentication attempts

## Troubleshooting

### **Error: "Token verification failed"**
**Possible Causes:**
1. Invalid JWT secret
2. Expired token
3. Malformed token
4. Missing environment variables

**Solutions:**
1. Check `JWT_SECRET` environment variable
2. Verify token hasn't expired
3. Check token format
4. Ensure all required env vars are set

### **Error: "No valid token verification method configured"**
**Cause**: All verification methods failed

**Solutions:**
1. Check JWT secret configuration
2. Verify worXstream API credentials
3. Check database connectivity
4. Review token format

### **Socket Connection Fails**
**Possible Causes:**
1. Authentication middleware error
2. Token verification timeout
3. Network issues

**Solutions:**
1. Check backend logs for errors
2. Verify token is being sent correctly
3. Check network connectivity
4. Ensure backend is running

## Development vs Production

### **Development Mode**
- Base64 token fallback enabled
- Verbose logging
- Less strict validation

### **Production Mode**
- Only secure verification methods
- Minimal logging
- Strict validation
- Base64 fallback disabled

## Migration Guide

### **From Header-Based Auth**
1. Remove `X-User-Info` header usage
2. Update frontend to send tokens
3. Update backend to verify tokens
4. Test authentication flow
5. Remove old header handling code

### **From Query Parameter Auth**
1. Remove user info from query parameters
2. Update frontend to send tokens
3. Update backend to verify tokens
4. Test authentication flow
5. Remove old query parameter handling code

## Testing

### **Test Token Verification**
```bash
# Test JWT verification
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:8000/

# Test socket connection
# Use a WebSocket client to connect with token
```

### **Test Different Token Types**
1. Valid JWT token
2. Expired JWT token
3. Invalid JWT token
4. worXstream API token
5. Database token
6. Base64 token (development only)

## Monitoring

### **Log Authentication Events**
- Successful authentications
- Failed authentication attempts
- Token verification method used
- Authentication response times

### **Metrics to Track**
- Authentication success rate
- Token verification method distribution
- Authentication response times
- Failed authentication patterns
