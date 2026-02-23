import calendarService from '../services/calendarService.js';
import { logger } from '../utils/logger.js';
import { getToken } from '../utils/tokenManager.js';

/**
 * Helper function to determine event category based on event properties
 */
const getEventCategory = (event) => {
  // You can implement custom logic here to categorize events
  // For now, we'll use a simple approach based on title/keywords
  const title = event.title.toLowerCase();
  
  if (title.includes('meeting') || title.includes('call') || title.includes('conference')) {
    return 'Meeting';
  } else if (title.includes('deadline') || title.includes('due') || title.includes('project')) {
    return 'Work';
  } else if (title.includes('birthday') || title.includes('anniversary') || title.includes('personal')) {
    return 'Personal';
  } else if (title.includes('travel') || title.includes('trip') || title.includes('flight')) {
    return 'Travel';
  } else if (title.includes('important') || title.includes('urgent')) {
    return 'Important';
  }
  
  return 'Other';
};

/**
 * Helper function to get event color based on category
 */
const getEventColor = (event) => {
  const category = getEventCategory(event);
  
  const colors = {
    'Meeting': '#3b82f6',    // Blue
    'Work': '#10b981',       // Green
    'Personal': '#f59e0b',   // Amber
    'Travel': '#8b5cf6',     // Purple
    'Important': '#ef4444',  // Red
    'Other': '#6b7280'       // Gray
  };
  
  return colors[category] || colors['Other'];
};

/**
 * Get calendar events for the active email account
 */
export const getCalendarEvents = async (req, res) => {
  try {
    const { email, startDate, endDate } = req.query;
    const { user } = req;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email parameter is required'
      });
    }

    if (!user || !user.id) {
      return res.status(401).json({
        success: false,
        error: 'User authentication required'
      });
    }

    logger.info(`📅 Calendar events request for ${email} by user ${user.id}`);

    // Get the access token for this email account
    // This would typically come from the email account's stored tokens
    // For now, we'll need to get this from the account data
    const accessToken = req.headers['x-access-token'];
    const provider = req.headers['x-provider'] || 'outlook';

    if (!accessToken) {
      return res.status(400).json({
        success: false,
        error: 'Access token required for calendar access'
      });
    }

    // Parse dates if provided
    let start = null;
    let end = null;
    
    if (startDate) {
      start = new Date(startDate);
      if (isNaN(start.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid start date format'
        });
      }
    }
    
    if (endDate) {
      end = new Date(endDate);
      if (isNaN(end.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid end date format'
        });
      }
    }

    // Get calendar events
    const events = await calendarService.getCalendarEvents(
      email,
      accessToken,
      provider,
      user.id,
      start,
      end
    );

    // Return complete event data without transformation
    const completeEvents = events.map(event => ({
      ...event, // Include all original fields
      id: event.eventId,
      start: event.startTime,
      end: event.endTime,
      allDay: event.isAllDay,
      category: getEventCategory(event),
      color: getEventColor(event)
    }));

    logger.info(`✅ Successfully retrieved ${completeEvents.length} calendar events for ${email}`);

    res.json({
      success: true,
      data: completeEvents,
      message: `Retrieved ${completeEvents.length} calendar events`
    });

  } catch (error) {
    logger.error('❌ Error in getCalendarEvents:', error.message);
    
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve calendar events',
      details: error.message
    });
  }
};

/**
 * Get calendar events for multiple email accounts
 */
export const getMultiAccountCalendarEvents = async (req, res) => {
  try {
    const { accounts, startDate, endDate } = req.body;
    const { user } = req;

    if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Accounts array is required'
      });
    }

    if (!user || !user.id) {
      return res.status(401).json({
        success: false,
        error: 'User authentication required'
      });
    }

    logger.info(`📅 Multi-account calendar events request for ${accounts.length} accounts by user ${user.id}`);

    // Parse dates if provided
    let start = null;
    let end = null;
    
    if (startDate) {
      start = new Date(startDate);
      if (isNaN(start.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid start date format'
        });
      }
    }
    
    if (endDate) {
      end = new Date(endDate);
      if (isNaN(end.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid end date format'
        });
      }
    }

    const allEvents = [];

    // Get events for each account
    for (const account of accounts) {
      try {
        if (!account.email || !account.accessToken || !account.provider) {
          logger.warn(`⚠️ Skipping account ${account.email} - missing required fields`);
          continue;
        }

        const events = await calendarService.getCalendarEvents(
          account.email,
          account.accessToken,
          account.provider,
          user.id,
          start,
          end
        );

        // Transform and add account info to events
        const transformedEvents = events.map(event => ({
          id: event.eventId,
          title: event.title,
          description: event.description,
          start: event.startTime,
          end: event.endTime,
          allDay: event.isAllDay,
          location: event.location,
          attendees: event.attendees,
          organizer: event.organizer,
          status: event.status,
          source: event.source,
          accountEmail: account.email,
          accountProvider: account.provider,
          category: getEventCategory(event),
          color: getEventColor(event)
        }));

        allEvents.push(...transformedEvents);

      } catch (accountError) {
        logger.error(`❌ Error fetching events for account ${account.email}:`, accountError.message);
        // Continue with other accounts even if one fails
      }
    }

    // Sort all events by start time
    allEvents.sort((a, b) => new Date(a.start) - new Date(b.start));

    logger.info(`✅ Successfully retrieved ${allEvents.length} calendar events from ${accounts.length} accounts`);

    res.json({
      success: true,
      data: allEvents,
      message: `Retrieved ${allEvents.length} calendar events from ${accounts.length} accounts`
    });

  } catch (error) {
    logger.error('❌ Error in getMultiAccountCalendarEvents:', error.message);
    
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve calendar events',
      details: error.message
    });
  }
};

/**
 * Get stored calendar events from database (without API calls)
 */
export const getStoredCalendarEvents = async (req, res) => {
  try {
    const { email, startDate, endDate } = req.query;
    const { user } = req;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email parameter is required'
      });
    }

    if (!user || !user.id) {
      return res.status(401).json({
        success: false,
        error: 'User authentication required'
      });
    }

    logger.info(`📅 Stored calendar events request for ${email} by user ${user.id}`);

    // Parse dates if provided
    let start = null;
    let end = null;
    
    if (startDate) {
      start = new Date(startDate);
      if (isNaN(start.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid start date format'
        });
      }
    }
    
    if (endDate) {
      end = new Date(endDate);
      if (isNaN(end.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid end date format'
        });
      }
    }

    // Get stored events from database
    const events = await calendarService.getStoredEvents(
      email,
      user.id,
      start,
      end
    );

    // Return complete event data without transformation
    const completeEvents = events.map(event => ({
      ...event, // Include all original fields
      id: event.eventId,
      start: event.startTime,
      end: event.endTime,
      allDay: event.isAllDay,
      category: getEventCategory(event),
      color: getEventColor(event)
    }));

    logger.info(`✅ Successfully retrieved ${completeEvents.length} stored calendar events for ${email}`);

    res.json({
      success: true,
      data: completeEvents,
      message: `Retrieved ${completeEvents.length} stored calendar events`
    });

  } catch (error) {
    logger.error('❌ Error in getStoredCalendarEvents:', error.message);
    
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve stored calendar events',
      details: error.message
    });
  }
};

/**
 * Sync calendar events for the active email account
 * This endpoint will fetch fresh events from the email provider and store them
 */
export const syncCalendarEvents = async (req, res) => {
  try {
    const { email, startDate, endDate } = req.query;
    const { user } = req;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email parameter is required'
      });
    }

    if (!user || !user.id) {
      return res.status(401).json({
        success: false,
        error: 'User authentication required'
      });
    }

    logger.info(`📅 Calendar sync request for ${email} by user ${user.id}`);

    // Parse dates if provided
    let start = null;
    let end = null;
    
    if (startDate) {
      start = new Date(startDate);
      if (isNaN(start.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid start date format'
        });
      }
    }
    
    if (endDate) {
      end = new Date(endDate);
      if (isNaN(end.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid end date format'
        });
      }
    }

    // Get the access token using the same pattern as email service
    try {
      logger.info(`🔍 Getting access token for user ${user.id}, email ${email}, provider outlook`);
      
      const accessToken = await getToken(user.id, email, 'outlook');
      
      if (!accessToken) {
        return res.status(400).json({
          success: false,
          error: 'No valid access token found for this email account. Please connect your Outlook account first.',
          code: 'NO_OUTLOOK_ACCOUNT'
        });
      }

      logger.info(`🔑 Found access token for ${email}, fetching calendar events...`);

      // Fetch calendar events using the calendar service
      const events = await calendarService.getCalendarEvents(
        email, 
        accessToken, 
        'outlook', 
        user.id,
        start, 
        end
      );

      logger.info(`✅ Successfully synced ${events.length} calendar events for ${email}`);

      res.json({
        success: true,
        data: events,
        message: `Synced ${events.length} calendar events from Outlook`
      });

    } catch (error) {
      logger.error('❌ Error in calendar sync:', error.message);
      logger.error('❌ Error stack:', error.stack);
      
      return res.status(500).json({
        success: false,
        error: 'Failed to sync calendar events',
        details: error.message
      });
    }

  } catch (error) {
    logger.error('❌ Error in syncCalendarEvents:', error.message);
    
    res.status(500).json({
      success: false,
      error: 'Failed to sync calendar events',
      details: error.message
    });
  }
};

/**
 * Get holidays from user's holiday calendars
 * GET /calendar/holidays
 * Query params: startDate (YYYY-MM-DD), endDate (YYYY-MM-DD)
 * Headers: Authorization: Bearer <token>, X-User-Info: <JSON user>
 */
export const getHolidays = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const { user } = req;

    if (!user || !user.id) {
      return res.status(401).json({
        success: false,
        error: 'User authentication required'
      });
    }

    logger.info(`🎉 Holidays request by user ${user.id} for date range: ${startDate || 'default'} to ${endDate || 'default'}`);

    // Parse dates if provided
    let start = null;
    let end = null;
    
    if (startDate) {
      start = new Date(startDate);
      if (isNaN(start.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid start date format. Use YYYY-MM-DD'
        });
      }
    }
    
    if (endDate) {
      end = new Date(endDate);
      if (isNaN(end.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid end date format. Use YYYY-MM-DD'
        });
      }
    }

    // Get access token - we need any Outlook token for the user
    // Try to get the first available Outlook token for this user
    const accessToken = req.headers['x-access-token'];
    
    if (!accessToken) {
      // If no token in header, try to get from token manager
      // Get user's first Outlook account
      const Token = (await import('../models/Token.js')).default;
      const userToken = await Token.findOne({ 
        worxstreamUserId: user.id, 
        provider: 'outlook' 
      });
      
      if (!userToken) {
        return res.status(400).json({
          success: false,
          error: 'No Outlook account connected. Please connect your Outlook account to view holidays.',
          code: 'NO_OUTLOOK_ACCOUNT'
        });
      }
      
      // Use the token from database
      try {
        const holidays = await calendarService.getHolidays(
          userToken.access_token,
          start,
          end
        );

        logger.info(`✅ Successfully retrieved ${holidays.length} holidays`);

        res.json({
          success: true,
          data: holidays
        });
      } catch (error) {
        logger.error('❌ Error fetching holidays:', error.message);
        
        res.status(500).json({
          success: false,
          error: 'Failed to retrieve holidays',
          details: error.message
        });
      }
    } else {
      // Use token from header
      try {
        const holidays = await calendarService.getHolidays(
          accessToken,
          start,
          end
        );

        logger.info(`✅ Successfully retrieved ${holidays.length} holidays`);

        res.json({
          success: true,
          data: holidays
        });
      } catch (error) {
        logger.error('❌ Error fetching holidays:', error.message);
        
        res.status(500).json({
          success: false,
          error: 'Failed to retrieve holidays',
          details: error.message
        });
      }
    }

  } catch (error) {
    logger.error('❌ Error in getHolidays:', error.message);
    
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve holidays',
      details: error.message
    });
  }
};
