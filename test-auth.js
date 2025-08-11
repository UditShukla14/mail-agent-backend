#!/usr/bin/env node

/**
 * Test script for JWT authentication
 * Run with: node test-auth.js
 */

import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';

// Test configuration
const TEST_CONFIG = {
  serverUrl: 'http://localhost:8000',
  userId: 'test-user-123',
  userEmail: 'test@example.com',
  jwtSecret: 'your-secret-key' // Should match your JWT_SECRET
};

// Generate a test JWT token
function generateTestToken() {
  const payload = {
    id: TEST_CONFIG.userId,
    email: TEST_CONFIG.userEmail,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (60 * 60) // 1 hour expiry
  };
  
  return jwt.sign(payload, TEST_CONFIG.jwtSecret);
}

// Test JWT verification
function testJWTVerification() {
  console.log('🔐 Testing JWT verification...');
  
  try {
    const token = generateTestToken();
    console.log('✅ JWT token generated:', token.substring(0, 50) + '...');
    
    const decoded = jwt.verify(token, TEST_CONFIG.jwtSecret);
    console.log('✅ JWT verification successful:', decoded);
    
    return token;
  } catch (error) {
    console.error('❌ JWT verification failed:', error.message);
    return null;
  }
}

// Test socket connection with token
async function testSocketConnection(token) {
  console.log('\n🔌 Testing socket connection...');
  
  return new Promise((resolve) => {
    const socket = io(TEST_CONFIG.serverUrl, {
      auth: { token },
      timeout: 10000
    });
    
    socket.on('connect', () => {
      console.log('✅ Socket connected successfully');
      console.log('📊 Socket ID:', socket.id);
      console.log('👤 User:', socket.user);
      socket.disconnect();
      resolve(true);
    });
    
    socket.on('connect_error', (error) => {
      console.error('❌ Socket connection failed:', error.message);
      resolve(false);
    });
    
    socket.on('disconnect', () => {
      console.log('👋 Socket disconnected');
    });
    
    // Timeout after 10 seconds
    setTimeout(() => {
      console.log('⏰ Connection timeout');
      socket.disconnect();
      resolve(false);
    }, 10000);
  });
}

// Test base64 token (development only)
function testBase64Token() {
  console.log('\n🔍 Testing base64 token (development only)...');
  
  try {
    const userInfo = {
      id: TEST_CONFIG.userId,
      email: TEST_CONFIG.userEmail
    };
    
    const base64Token = Buffer.from(JSON.stringify(userInfo)).toString('base64');
    console.log('✅ Base64 token generated:', base64Token);
    
    const decoded = JSON.parse(Buffer.from(base64Token, 'base64').toString());
    console.log('✅ Base64 decoding successful:', decoded);
    
    return base64Token;
  } catch (error) {
    console.error('❌ Base64 token test failed:', error.message);
    return null;
  }
}

// Main test function
async function runTests() {
  console.log('🚀 Starting authentication tests...\n');
  
  // Test 1: JWT verification
  const jwtToken = testJWTVerification();
  if (!jwtToken) {
    console.log('❌ JWT test failed, stopping tests');
    return;
  }
  
  // Test 2: Socket connection with JWT
  const socketSuccess = await testSocketConnection(jwtToken);
  
  // Test 3: Base64 token (development)
  const base64Token = testBase64Token();
  
  // Test 4: Socket connection with base64 (if in development)
  if (base64Token && process.env.NODE_ENV === 'development') {
    console.log('\n🔌 Testing socket connection with base64 token...');
    await testSocketConnection(base64Token);
  }
  
  // Summary
  console.log('\n📊 Test Summary:');
  console.log('✅ JWT Verification:', jwtToken ? 'PASSED' : 'FAILED');
  console.log('✅ Socket Connection:', socketSuccess ? 'PASSED' : 'FAILED');
  console.log('✅ Base64 Token:', base64Token ? 'PASSED' : 'FAILED');
  
  if (socketSuccess) {
    console.log('\n🎉 All tests passed! Authentication is working correctly.');
  } else {
    console.log('\n⚠️ Some tests failed. Check your configuration and server status.');
  }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().catch(console.error);
}

export { runTests, generateTestToken, testJWTVerification };
