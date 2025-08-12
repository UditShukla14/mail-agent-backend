import axios from 'axios';
import CalendarEvent from '../models/CalendarEvent.js';
import { logger } from '../utils/logger.js';

class CalendarService {
  constructor() {
    this.outlookApiUrl = 'https://graph.microsoft.com/v1.0';
    this.gmailApiUrl = 'https://www.googleapis.com/calendar/v3';
  }

  /**
   * Get calendar events for a specific email account
   */
  async getCalendarEvents(email, accessToken, provider, worxstreamUserId, startDate = null, endDate = null) {
    try {
      logger.info(`📅 Fetching calendar events for ${email} (${provider})`);
      
      let events = [];
      
      if (provider === 'outlook') {
        events = await this.getOutlookEvents(email, accessToken, startDate, endDate);
      } else if (provider === 'gmail') {
        events = await this.getGmailEvents(email, accessToken, startDate, endDate);
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }

      // Store events in database
      await this.storeEvents(events, email, provider, worxstreamUserId);
      
      // Return the raw events from API (not from database)
      return events;
      
    } catch (error) {
      logger.error(`❌ Error fetching calendar events for ${email}:`, error.message);
      throw error;
    }
  }

  /**
   * Get calendar events from Outlook/Microsoft Graph API
   */
  async getOutlookEvents(email, accessToken, startDate, endDate) {
    try {
      // Validate access token
      if (!accessToken || typeof accessToken !== 'string') {
        throw new Error(`Invalid access token: ${typeof accessToken} - ${accessToken}`);
      }
      
      const now = new Date();
      // Use a more reasonable date range: 30 days ago to 90 days in the future
      const start = startDate || new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
      const end = endDate || new Date(now.getTime() + (90 * 24 * 60 * 60 * 1000));
      
      logger.info(`🔍 Date range for calendar events:`, {
        start: start.toISOString(),
        end: end.toISOString(),
        startDate: startDate?.toISOString(),
        endDate: endDate?.toISOString()
      });

      // Use the complete endpoint with all fields as requested
      const url = `${this.outlookApiUrl}/me/events`;
      
      // Get all the fields you need for complete event data
      const params = {
        $select: 'subject,bodyPreview,organizer,attendees,start,end,location,id,isAllDay,recurrence,responseStatus,sensitivity',
        $top: 1000
      };
      
      // Add date filter for reasonable date ranges
      const daysInFuture = Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      if (daysInFuture <= 365) { // Only filter if within 1 year
        params.$filter = `start/dateTime ge '${start.toISOString()}' and end/dateTime le '${end.toISOString()}'`;
        params.$orderby = 'start/dateTime';
        params.$top = 1000;
      }

      logger.info(`📅 Fetching Outlook events from ${start.toISOString()} to ${end.toISOString()}`);
      logger.info(`🔍 API Request Details:`, {
        url: url,
        headers: {
          'Authorization': `Bearer ${accessToken.substring(0, 20)}...`,
          'Content-Type': 'application/json'
        },
        params: params
      });

      // First test if we can access the user's profile (basic permission test)
      try {
        const profileResponse = await axios.get(`${this.outlookApiUrl}/me`, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        });
        logger.info(`✅ Profile access test successful: ${profileResponse.data.mail || profileResponse.data.userPrincipalName}`);
      } catch (profileError) {
        logger.warn(`⚠️ Profile access test failed:`, profileError.message);
      }

      // Test calendar access permissions
      try {
        const calendarResponse = await axios.get(`${this.outlookApiUrl}/me/calendars`, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        });
        logger.info(`✅ Calendar access test successful: Found ${calendarResponse.data.value?.length || 0} calendars`);
      } catch (calendarError) {
        logger.warn(`⚠️ Calendar access test failed:`, calendarError.message);
        if (calendarError.response) {
          logger.warn(`⚠️ Calendar error details:`, {
            status: calendarError.response.status,
            data: calendarError.response.data
          });
        }
      }

      // Get user's timezone information
      try {
        const userResponse = await axios.get(`${this.outlookApiUrl}/me`, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        });
        logger.info(`✅ User timezone info:`, {
          mail: userResponse.data.mail,
          userPrincipalName: userResponse.data.userPrincipalName,
          timeZone: userResponse.data.mailboxSettings?.timeZone || 'Not specified'
        });
      } catch (userError) {
        logger.warn(`⚠️ Could not get user timezone info:`, userError.message);
      }

      logger.info(`🔍 Making Microsoft Graph API call to: ${url}`);
      logger.info(`🔍 Request parameters:`, JSON.stringify(params, null, 2));
      
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        params
      });

      logger.info(`✅ Fetched ${response.data.value?.length || 0} Outlook events`);
      logger.info(`🔍 Response structure:`, {
        hasData: !!response.data,
        hasValue: !!response.data.value,
        valueType: typeof response.data.value,
        isArray: Array.isArray(response.data.value)
      });
      
      if (response.data.value && Array.isArray(response.data.value)) {
        return response.data.value.map(event => this.transformOutlookEvent(event, email));
      } else {
        logger.warn(`⚠️ Unexpected response format:`, response.data);
        return [];
      }
      
    } catch (error) {
      logger.error(`❌ Error fetching Outlook events:`, error.message);
      
      // Log more details about the error
      if (error.response) {
        logger.error(`❌ Microsoft Graph API Error Response:`, {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
          headers: error.response.headers
        });
      } else if (error.request) {
        logger.error(`❌ No response received from Microsoft Graph API:`, error.request);
      } else {
        logger.error(`❌ Error setting up request:`, error.message);
      }
      
      throw new Error(`Failed to fetch Outlook calendar events: ${error.message}`);
    }
  }

  /**
   * Get calendar events from Gmail/Google Calendar API
   */
  async getGmailEvents(email, accessToken, startDate, endDate) {
    try {
      const now = new Date();
      const start = startDate || new Date(now.getFullYear(), now.getMonth(), 1);
      const end = endDate || new Date(now.getFullYear(), now.getMonth() + 1, 0);

      // Get primary calendar ID
      const calendarResponse = await axios.get(`${this.gmailApiUrl}/users/me/calendarList`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      const primaryCalendar = calendarResponse.data.items.find(cal => cal.primary);
      if (!primaryCalendar) {
        throw new Error('Primary calendar not found');
      }

      const url = `${this.gmailApiUrl}/calendars/${primaryCalendar.id}/events`;
      const params = {
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        orderBy: 'startTime',
        singleEvents: true,
        maxResults: 1000
      };

      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        params
      });

      return response.data.items.map(event => this.transformGmailEvent(event, email));
      
    } catch (error) {
      logger.error(`❌ Error fetching Gmail events:`, error.message);
      throw new Error(`Failed to fetch Gmail calendar events: ${error.message}`);
    }
  }

  /**
   * Transform Outlook event to our format - preserve all raw data
   */
  transformOutlookEvent(outlookEvent, email) {
    // Return the complete event data with all fields from Microsoft Graph API
    return {
      // Core event fields
      eventId: outlookEvent.id,
      title: outlookEvent.subject || 'No Title',
      description: outlookEvent.bodyPreview || '',
      startTime: outlookEvent.start.dateTime || outlookEvent.start.date,
      endTime: outlookEvent.end.dateTime || outlookEvent.end.date,
      startTimeZone: outlookEvent.start.timeZone,
      endTimeZone: outlookEvent.end.timeZone,
      isAllDay: outlookEvent.isAllDay || false,
      location: outlookEvent.location?.displayName || '',
      
      // Attendees and organizer
      attendees: (outlookEvent.attendees || []).map(attendee => ({
        email: attendee.emailAddress.address,
        name: attendee.emailAddress.name,
        responseStatus: attendee.status.response || 'needsAction'
      })),
      organizer: outlookEvent.organizer ? {
        email: outlookEvent.organizer.emailAddress.address,
        name: outlookEvent.organizer.emailAddress.name
      } : null,
      
      // Additional fields
      recurrence: outlookEvent.recurrence ? JSON.stringify(outlookEvent.recurrence) : null,
      status: outlookEvent.responseStatus?.response || 'confirmed',
      visibility: outlookEvent.sensitivity || 'default',
      source: 'outlook',
      
      // Preserve all raw data from Microsoft Graph API
      rawData: {
        id: outlookEvent.id,
        subject: outlookEvent.subject,
        body: outlookEvent.body,
        bodyPreview: outlookEvent.bodyPreview,
        start: outlookEvent.start,
        end: outlookEvent.end,
        location: outlookEvent.location,
        attendees: outlookEvent.attendees,
        organizer: outlookEvent.organizer,
        isAllDay: outlookEvent.isAllDay,
        recurrence: outlookEvent.recurrence,
        responseStatus: outlookEvent.responseStatus,
        sensitivity: outlookEvent.sensitivity,
        // Add any other fields that might be present
        ...outlookEvent
      }
    };
  }

  /**
   * Transform Gmail event to our format
   */
  transformGmailEvent(gmailEvent, email) {
    return {
      eventId: gmailEvent.id,
      title: gmailEvent.summary || 'No Title',
      description: gmailEvent.description || '',
      startTime: gmailEvent.start.dateTime || gmailEvent.start.date,
      endTime: gmailEvent.end.dateTime || gmailEvent.end.date,
      startTimeZone: gmailEvent.start.timeZone,
      endTimeZone: gmailEvent.end.timeZone,
      isAllDay: !gmailEvent.start.dateTime,
      location: gmailEvent.location || '',
      attendees: (gmailEvent.attendees || []).map(attendee => ({
        email: attendee.email,
        name: attendee.displayName || attendee.email,
        responseStatus: attendee.responseStatus || 'needsAction'
      })),
      organizer: gmailEvent.organizer ? {
        email: gmailEvent.organizer.email,
        name: gmailEvent.organizer.displayName || gmailEvent.organizer.email
      } : null,
      recurrence: gmailEvent.recurrence ? JSON.stringify(gmailEvent.recurrence) : null,
      status: gmailEvent.status || 'confirmed',
      visibility: gmailEvent.visibility || 'default',
      source: 'gmail'
    };
  }

  /**
   * Store events in database
   */
  async storeEvents(events, email, provider, worxstreamUserId) {
    try {
      for (const event of events) {
        await CalendarEvent.findOneAndUpdate(
          { 
            eventId: event.eventId,
            emailAccount: email,
            worxstreamUserId 
          },
          {
            ...event,
            emailAccount: email,
            source: provider,
            worxstreamUserId,
            lastSynced: new Date()
          },
          { 
            upsert: true, 
            new: true,
            setDefaultsOnInsert: true
          }
        );
      }
      
      logger.info(`✅ Stored ${events.length} calendar events for ${email}`);
    } catch (error) {
      logger.error(`❌ Error storing calendar events:`, error.message);
      throw error;
    }
  }

  /**
   * Get stored events from database
   */
  async getStoredEvents(email, worxstreamUserId, startDate = null, endDate = null) {
    try {
      const now = new Date();
      const start = startDate || new Date(now.getFullYear(), now.getMonth(), 1);
      const end = endDate || new Date(now.getFullYear(), now.getMonth() + 1, 0);

      const events = await CalendarEvent.find({
        emailAccount: email,
        worxstreamUserId,
        startTime: { $gte: start },
        endTime: { $lte: end }
      }).sort({ startTime: 1 });

      logger.info(`📅 Retrieved ${events.length} stored calendar events for ${email}`);
      return events;
      
    } catch (error) {
      logger.error(`❌ Error retrieving stored calendar events:`, error.message);
      throw error;
    }
  }

  /**
   * Delete old events (cleanup)
   */
  async cleanupOldEvents(daysToKeep = 30) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const result = await CalendarEvent.deleteMany({
        endTime: { $lt: cutoffDate }
      });

      logger.info(`🧹 Cleaned up ${result.deletedCount} old calendar events`);
      return result.deletedCount;
      
    } catch (error) {
      logger.error(`❌ Error cleaning up old calendar events:`, error.message);
      throw error;
    }
  }
}

export default new CalendarService();
