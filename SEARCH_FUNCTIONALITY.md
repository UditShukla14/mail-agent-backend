# Email Search Functionality

This document describes the email search functionality that has been integrated into the mail agent system.

## Overview

The search functionality allows users to search through their emails across both Outlook and Gmail accounts. It provides:

- Real-time search across all email folders
- Search within specific folders
- Search across multiple email accounts
- Pagination support for large result sets
- Integration with the existing email list interface

## Backend Implementation

### Search Services

#### Outlook Search (`services/outlookService.js`)
- Uses Microsoft Graph API search functionality
- Supports searching across all folders or within specific folders
- Returns paginated results with nextLink support

#### Gmail Search (`services/gmailService.js`)
- Uses Gmail API search functionality
- Supports Gmail's advanced search operators
- Returns paginated results with pageToken support

### API Endpoints

#### Search Emails
```
POST /api/mail-agent/search
```

**Request Body:**
```json
{
  "query": "search term",
  "email": "user@example.com",
  "folderId": "optional-folder-id",
  "page": 1,
  "limit": 20
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "messages": [...],
    "nextLink": "next-page-token",
    "totalCount": 150,
    "query": "search term",
    "email": "user@example.com",
    "folderId": "optional-folder-id"
  }
}
```

#### Get Folders
```
GET /api/mail-agent/folders?email=user@example.com
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "folder-id",
      "displayName": "Inbox",
      "totalItemCount": 100,
      "unreadItemCount": 5
    }
  ]
}
```

## Frontend Implementation

### Search Bar Component (`components/Header/SearchBar.tsx`)
- Enhanced search bar with dropdown selectors for email accounts and folders
- Real-time search with debouncing
- Clear search functionality
- Search status indicators

### Email List Integration (`pages/Mails/components/EmailList.tsx`)
- Search mode toggle
- Search results display
- Load more functionality for pagination
- Integration with existing email detail views

### Search API Service (`pages/Mails/lib/api/emailSearch.ts`)
- TypeScript interfaces for search functionality
- API wrapper functions for search operations
- Error handling and response typing

## Features

### Search Capabilities
- **Full-text search**: Search through email subject, body, sender, and recipient fields
- **Folder-specific search**: Search within specific folders or across all folders
- **Account-specific search**: Search within specific email accounts
- **Real-time results**: Instant search results with debounced input

### User Interface
- **Search bar**: Prominent search input with account and folder selectors
- **Search results**: Clean display of search results with email previews
- **Pagination**: Load more functionality for large result sets
- **Clear search**: Easy way to return to normal email view

### Integration
- **Seamless navigation**: Click on search results to view full email details
- **State management**: Proper state handling for search mode vs normal mode
- **Error handling**: Graceful error handling for failed searches

## Usage

### Basic Search
1. Enter search terms in the search bar
2. Press Enter or wait for auto-search
3. View results in the email list
4. Click on any result to view the full email

### Advanced Search
1. Select specific email account from dropdown
2. Select specific folder (optional)
3. Enter search query
4. Use pagination to load more results

### Clear Search
- Click the X button in the search bar
- Or click the clear button next to search results

## Technical Details

### Search Query Format
- **Outlook**: Uses Microsoft Graph search syntax
- **Gmail**: Uses Gmail search operators (from:, to:, subject:, etc.)

### Performance Considerations
- Debounced search input (500ms delay)
- Pagination to limit result set size
- Caching of folder lists
- Optimistic UI updates

### Error Handling
- Network error handling
- Invalid search query handling
- Expired token handling
- Rate limiting considerations

## Future Enhancements

### Planned Features
- **Advanced search filters**: Date range, attachment type, etc.
- **Search history**: Save and reuse search queries
- **Search suggestions**: Auto-complete for common searches
- **Search analytics**: Track popular search terms

### Performance Improvements
- **Search indexing**: Pre-index emails for faster searches
- **Result caching**: Cache search results for better performance
- **Background search**: Search while typing without blocking UI

## Testing

### Manual Testing
1. Connect email accounts (Outlook and/or Gmail)
2. Navigate to the mail interface
3. Use the search bar to search for emails
4. Test different search scenarios:
   - Simple text search
   - Account-specific search
   - Folder-specific search
   - Pagination

### Automated Testing
- Unit tests for search services
- Integration tests for API endpoints
- UI tests for search functionality

## Troubleshooting

### Common Issues
1. **No search results**: Check if email account is properly connected
2. **Search not working**: Verify API endpoints are accessible
3. **Slow search**: Check network connectivity and API rate limits
4. **Authentication errors**: Ensure tokens are valid and not expired

### Debug Information
- Check browser console for API errors
- Verify search query format
- Check network tab for failed requests
- Review server logs for backend errors
