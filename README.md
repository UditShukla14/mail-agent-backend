# Mail Agent Backend - worXstream Integration

This is the updated mail-agent backend that integrates with the main worXstream application for authentication and user management.

## Overview

The mail-agent backend has been updated to:
- Remove JWT-based authentication
- Integrate with worXstream's authentication system
- Use worXstream user IDs instead of app-specific user IDs
- Remove encryption dependencies (crypto-js)
- Simplify the authentication flow

## Key Changes

### Authentication
- **Before**: JWT tokens with local verification
- **After**: Bearer tokens verified against worXstream backend

### User Management
- **Before**: Local user database with appUserId
- **After**: Uses worXstream user IDs and user data

### Token Storage
- **Before**: Encrypted tokens stored locally
- **After**: Plain tokens stored with worXstream user association

## Environment Variables

Create a `.env` file with the following variables:

```env
# Server Configuration
PORT=8000
NODE_ENV=development

# MongoDB Configuration
# The connection string is configured to use the mailAgent database
# mongodb+srv://doadmin:94f0Pq2rX1768uKe@db-mongodb-nyc1-38465-c4ba6c32.mongo.ondigitalocean.com/mailAgent?authSource=admin

# worXstream Backend Integration
WORXSTREAM_API_URL=http://localhost:8080

# Microsoft Outlook OAuth Configuration
CLIENT_ID=your_outlook_client_id
CLIENT_SECRET=your_outlook_client_secret
REDIRECT_URI=http://localhost:8000/auth/outlook/redirect
TENANT_ID=common

# Google Gmail OAuth Configuration
GMAIL_CLIENT_ID=your_gmail_client_id
GMAIL_CLIENT_SECRET=your_gmail_client_secret
GMAIL_REDIRECT_URI=http://localhost:8000/auth/gmail/redirect

# AI Service Configuration (Claude)
ANTHROPIC_API_KEY=your_anthropic_api_key

# Email Processing Configuration
ENRICHMENT_BATCH_SIZE=10
ENRICHMENT_DELAY=5000

# Logging Configuration
LOG_LEVEL=info
```

## API Endpoints

### Authentication (requires worXstream token)
- `GET /auth/outlook/login` - Initiate Outlook OAuth
- `GET /auth/gmail/login` - Initiate Gmail OAuth
- `POST /auth/callback` - Verify OAuth callback

### Account Management
- `GET /account/accounts` - Get user's connected email accounts
- `DELETE /account/unlink` - Unlink an email account

### Email Analytics
- `GET /email-analytics/stats` - Get email statistics
- `GET /email-analytics/analytics` - Get detailed analytics
- `GET /email-analytics/unread-summary` - Get unread emails summary

### Email Categories
- `GET /email-categories/` - Get categories for an email account
- `PUT /email-categories/` - Update categories
- `POST /email-categories/add` - Add a new category
- `DELETE /email-categories/:categoryName` - Delete a category
- `GET /email-categories/accounts` - Get all user email accounts

### AI Reply Generation
- `POST /ai-reply/generate-reply` - Generate AI reply
- `POST /ai-reply/generate-compose` - Generate new email
- `POST /ai-reply/improve-email` - Improve existing email

### Focus Management
- `POST /focus/add` - Add a new focus item (subject or email)
- `DELETE /focus/:folderName` - Remove a focus item
- `GET /focus/` - Get all focus items for an email account
- `GET /focus/:folderName/emails` - Get emails for a specific focus folder

## Authentication Flow

1. User logs into worXstream main application
2. worXstream provides a Bearer token
3. Mail-agent verifies token with worXstream backend
4. Mail-agent uses worXstream user ID for all operations
5. OAuth flows use worXstream user ID for token storage

## Database Schema Changes

### Token Model
```javascript
{
  worxstreamUserId: Number,  // Changed from appUserId: String
  email: String,
  provider: String,
  access_token: String,      // No longer encrypted
  refresh_token: String,     // No longer encrypted
  expires_in: Number,
  timestamp: Number
}
```

### User Model
```javascript
{
  email: String,
  worxstreamUserId: Number,  // Changed from appUserId: String
  name: String               // Added name field
}
```

### EmailAccount Model
```javascript
{
  userId: ObjectId,
  email: String,
  provider: String,
  categories: [{
    name: String,
    label: String,
    description: String,
    color: String,
    createdAt: Date
  }],
  focusedItems: [{
    type: String,           // 'subject' or 'email'
    value: String,          // subject text or email address
    folderName: String,     // generated focus folder name
    createdAt: Date,
    lastActivity: Date,
    emailCount: Number,
    isActive: Boolean
  }],
  isActive: Boolean
}
```

### Email Model
```javascript
{
  id: String,
  userId: ObjectId,
  email: String,
  from: String,
  to: String,
  cc: String,
  bcc: String,
  subject: String,
  content: String,
  timestamp: Date,
  read: Boolean,
  folder: String,
  focusFolder: String,      // Focus folder this email belongs to
  important: Boolean,
  flagged: Boolean,
  aiMeta: {
    summary: String,
    category: String,
    priority: String,
    sentiment: String,
    actionItems: [String],
    enrichedAt: Date,
    version: String,
    error: String
  },
  isProcessed: Boolean
}
```

## Installation

1. Install dependencies:
```bash
npm install
```

2. Set up environment variables in `.env`

3. Start the server:
```bash
npm run dev
```

## Integration with worXstream

The mail-agent is now designed to be accessed only through the main worXstream application. Users must:

1. Log into worXstream
2. Navigate to the mail section
3. Connect their email accounts through the integrated OAuth flow

All API calls require a valid worXstream Bearer token in the Authorization header.

## Migration Notes

If migrating from the old version:

1. Update your frontend to use worXstream authentication
2. Update API calls to include Bearer tokens
3. Update user ID references from appUserId to worxstreamUserId
4. Remove any local JWT handling
5. Update OAuth callback URLs to work with the new flow

## Focus Feature

The Focus feature allows users to track ongoing conversations and important topics by creating virtual folders for specific subjects or email addresses.

### How It Works

1. **Subject Focus**: Users can mark any email subject as "focused" to track all emails with similar subjects
2. **Email Focus**: Users can focus on specific email addresses to track all communication with that person/entity
3. **Automatic Assignment**: New emails are automatically assigned to focus folders if they match the criteria
4. **Real-time Updates**: Focus folders are updated in real-time as new emails arrive

### Focus Item Types

- **Subject Focus**: Matches emails with similar subjects (case-insensitive, partial matching)
- **Email Focus**: Matches emails where the address appears in from/to/cc/bcc fields

### Benefits

- **Conversation Tracking**: Keep all related emails in one virtual folder
- **Priority Management**: Focus on important topics or people
- **Organization**: Automatically organize emails without manual sorting
- **Performance**: Efficient querying with database indexes

### Technical Implementation

- **Caching**: Focus items are cached for performance (5-minute expiry)
- **Automatic Assignment**: New emails are checked against focus criteria during save
- **Database Indexing**: Optimized queries for focus folder operations
- **Real-time Updates**: Focus item activity is updated when new emails arrive

## Security

- All authentication is now handled by worXstream
- No local JWT secrets or encryption keys needed
- Tokens are verified against worXstream backend on each request
- OAuth tokens are stored with worXstream user association 