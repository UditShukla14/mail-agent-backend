// controllers/emailSearchController.js
import Email from '../models/email.js';
import logger from '../utils/logger.js';

export const searchEmails = async (req, res) => {
  try {
    const { email, searchTerm, folder, limit = 50, offset = 0 } = req.query;
    const worxstreamUserId = req.user.id;

    // Validate required parameters
    if (!email || !searchTerm) {
      return res.status(400).json({
        success: false,
        error: 'Email and searchTerm are required',
        code: 'MISSING_PARAMETERS'
      });
    }

    // Sanitize search term
    const sanitizedSearchTerm = searchTerm.trim();
    if (sanitizedSearchTerm.length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Search term must be at least 2 characters long',
        code: 'INVALID_SEARCH_TERM'
      });
    }

    // Build search query
    const searchQuery = {
      userId: worxstreamUserId,
      email: email,
      $or: [
        // Search in preview field (primary search)
        { preview: { $regex: sanitizedSearchTerm, $options: 'i' } },
        // Search in subject field
        { subject: { $regex: sanitizedSearchTerm, $options: 'i' } },
        // Search in from field
        { from: { $regex: sanitizedSearchTerm, $options: 'i' } },
        // Search in to field
        { to: { $regex: sanitizedSearchTerm, $options: 'i' } },
        // Search in content field (if available)
        { content: { $regex: sanitizedSearchTerm, $options: 'i' } }
      ]
    };

    // Add folder filter if specified
    if (folder && folder !== 'all') {
      searchQuery.folder = folder;
    }

    logger.info(`Searching emails for user ${worxstreamUserId}, email: ${email}, term: "${sanitizedSearchTerm}"`);

    // Execute search with pagination
    const emails = await Email.find(searchQuery)
      .sort({ timestamp: -1 }) // Most recent first
      .limit(parseInt(limit))
      .skip(parseInt(offset))
      .select({
        _id: 1,
        id: 1,
        subject: 1,
        from: 1,
        to: 1,
        preview: 1,
        timestamp: 1,
        read: 1,
        folder: 1,
        important: 1,
        flagged: 1,
        aiMeta: 1,
        createdAt: 1,
        updatedAt: 1
      })
      .lean();

    // Get total count for pagination
    const totalCount = await Email.countDocuments(searchQuery);

    // Process results to highlight search terms
    const processedEmails = emails.map(email => {
      const result = {
        ...email,
        searchHighlights: {
          preview: highlightSearchTerm(email.preview, sanitizedSearchTerm),
          subject: highlightSearchTerm(email.subject, sanitizedSearchTerm),
          from: highlightSearchTerm(email.from, sanitizedSearchTerm),
          to: highlightSearchTerm(email.to, sanitizedSearchTerm)
        }
      };
      return result;
    });

    logger.info(`Search completed. Found ${emails.length} emails out of ${totalCount} total`);

    res.json({
      success: true,
      data: {
        emails: processedEmails,
        pagination: {
          total: totalCount,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: (parseInt(offset) + parseInt(limit)) < totalCount
        },
        searchInfo: {
          term: sanitizedSearchTerm,
          email: email,
          folder: folder || 'all'
        }
      }
    });

  } catch (error) {
    logger.error('Email search error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to search emails',
      code: 'SEARCH_ERROR'
    });
  }
};

// Helper function to highlight search terms in text
const highlightSearchTerm = (text, searchTerm) => {
  if (!text || !searchTerm) return text;
  
  const regex = new RegExp(`(${searchTerm})`, 'gi');
  return text.replace(regex, '<mark>$1</mark>');
};
