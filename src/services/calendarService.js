import axios from 'axios';
import CalendarEvent from '../models/CalendarEvent.js';
import { logger } from '../utils/logger.js';
import { retryTransient } from '../utils/transientRetry.js';
import { withTokenRefresh } from '../utils/outlookAuthRetry.js';
import { getToken, refreshSpecificToken } from '../utils/tokenManager.js';
import { installGraphDefaults } from './graphDefaults.js';

installGraphDefaults();

const GRAPH = 'https://graph.microsoft.com/v1.0';
const EVENT_SELECT = 'id,subject,body,bodyPreview,organizer,attendees,start,end,location,isAllDay,isCancelled,showAs,recurrence,responseStatus,sensitivity,type,seriesMasterId';
const HOLIDAY_CALENDAR = /holiday/i;
const MAX_PAGES = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/** All-day events carry midnight timestamps; expose them as plain dates so they never slide to the neighbouring day. */
const toDateOnly = (value) => String(value || '').slice(0, 10);

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
        events = await this.getOutlookEvents(email, accessToken, startDate, endDate, worxstreamUserId);
      } else if (provider === 'gmail') {
        events = await this.getGmailEvents(email, accessToken, startDate, endDate, worxstreamUserId);
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
   * Get calendar events from Outlook/Microsoft Graph API.
   *
   * Uses calendarView (not /me/events) so recurring events are expanded into occurrences, reads every calendar
   * on the mailbox (including the "Holidays" calendar), follows paging, and sends times in UTC.
   */
  async getOutlookEvents(email, accessToken, startDate, endDate, worxstreamUserId = null) {
    if (!accessToken || typeof accessToken !== 'string') {
      throw new Error('Invalid access token for Outlook calendar');
    }

    const now = new Date();
    const start = startDate || new Date(now.getTime() - 30 * DAY_MS);
    const end = endDate || new Date(now.getTime() + 90 * DAY_MS);
    logger.info(`📅 Fetching Outlook events for ${email} from ${start.toISOString()} to ${end.toISOString()}`);

    const run = (token) => this.fetchOutlookCalendarView(token, start, end, email);
    try {
      if (worxstreamUserId == null) return await run(accessToken);
      return await withTokenRefresh(run, {
        accessToken,
        refresh: () => refreshSpecificToken(worxstreamUserId, email, 'outlook'),
        getFreshToken: () => getToken(worxstreamUserId, email, 'outlook')
      });
    } catch (error) {
      logger.error(`❌ Error fetching Outlook events:`, error.response?.data || error.message);
      throw new Error(`Failed to fetch Outlook calendar events: ${error.message}`);
    }
  }

  async fetchOutlookCalendarView(accessToken, start, end, email) {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Prefer: 'outlook.timezone="UTC"'
    };

    // Every calendar on the mailbox; fall back to the default one if listing is not permitted.
    let calendars = [{ id: null, name: 'Calendar' }];
    try {
      const res = await retryTransient(() => axios.get(`${GRAPH}/me/calendars`, { headers, params: { $top: 100, $select: 'id,name,color,isDefaultCalendar' } }));
      if (res.data.value?.length) calendars = res.data.value;
    } catch (err) {
      if (err.response?.status === 401) throw err;
      logger.warn(`⚠️ Could not list calendars for ${email}, using default: ${err.message}`);
    }

    const events = [];
    const seen = new Set();

    for (const calendar of calendars) {
      const base = calendar.id
        ? `${GRAPH}/me/calendars/${encodeURIComponent(calendar.id)}/calendarView`
        : `${GRAPH}/me/calendarView`;
      const isHoliday = HOLIDAY_CALENDAR.test(calendar.name || '');
      let next = base;
      let pages = 0;
      try {
        while (next && pages < MAX_PAGES) {
          const url = next;
          const res = await retryTransient(() => axios.get(url, {
            headers,
            params: url === base
              ? { startDateTime: start.toISOString(), endDateTime: end.toISOString(), $select: EVENT_SELECT, $orderby: 'start/dateTime', $top: 250 }
              : undefined
          }));
          for (const raw of res.data.value || []) {
            if (raw.isCancelled || seen.has(raw.id)) continue;
            seen.add(raw.id);
            events.push(this.transformOutlookEvent(raw, email, { calendarName: calendar.name, isHoliday }));
          }
          next = res.data['@odata.nextLink'] || null;
          pages += 1;
        }
      } catch (err) {
        if (err.response?.status === 401) throw err;
        // One unreadable calendar (e.g. shared/read-only) must not hide the rest.
        logger.warn(`⚠️ Skipping calendar "${calendar.name}" for ${email}: ${err.message}`);
      }
    }

    logger.info(`✅ Fetched ${events.length} Outlook events across ${calendars.length} calendar(s) for ${email}`);
    return events;
  }

  /**
   * Get calendar events from Gmail/Google Calendar API
   */
  async getGmailEvents(email, accessToken, startDate, endDate) {
    try {
      const now = new Date();
      const start = startDate || new Date(now.getTime() - 30 * DAY_MS);
      const end = endDate || new Date(now.getTime() + 90 * DAY_MS);
      const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

      const list = await retryTransient(() => axios.get(`${this.gmailApiUrl}/users/me/calendarList`, { headers }));
      const calendars = (list.data.items || []).filter(cal => cal.selected !== false);
      if (!calendars.length) throw new Error('No calendars found');

      const events = [];
      const seen = new Set();
      for (const cal of calendars) {
        const isHoliday = /#holiday@group\.v\.calendar\.google\.com$/.test(cal.id) || /holiday/i.test(cal.summary || '');
        let pageToken;
        let pages = 0;
        try {
          do {
            const res = await retryTransient(() => axios.get(`${this.gmailApiUrl}/calendars/${encodeURIComponent(cal.id)}/events`, {
              headers,
              params: { timeMin: start.toISOString(), timeMax: end.toISOString(), orderBy: 'startTime', singleEvents: true, maxResults: 250, pageToken }
            }));
            for (const ev of res.data.items || []) {
              const key = `${cal.id}:${ev.id}`;
              if (ev.status === 'cancelled' || seen.has(key)) continue;
              seen.add(key);
              events.push(this.transformGmailEvent(ev, email, { calendarName: cal.summary, isHoliday }));
            }
            pageToken = res.data.nextPageToken;
            pages += 1;
          } while (pageToken && pages < MAX_PAGES);
        } catch (err) {
          if (err.response?.status === 401) throw err;
          logger.warn(`⚠️ Skipping Google calendar "${cal.summary}" for ${email}: ${err.message}`);
        }
      }
      return events;
    } catch (error) {
      logger.error(`❌ Error fetching Gmail events:`, error.message);
      throw new Error(`Failed to fetch Gmail calendar events: ${error.message}`);
    }
  }

  /**
   * Transform Outlook event to our format - preserve all raw data
   */
  transformOutlookEvent(outlookEvent, email, { calendarName = '', isHoliday = false } = {}) {
    const allDay = Boolean(outlookEvent.isAllDay);
    // Times were requested in UTC; mark them so clients never re-interpret them in another zone.
    const asUtc = (v) => (allDay ? toDateOnly(v) : `${String(v).replace(/(\.\d{3})\d+$/, '$1')}Z`);
    const status = outlookEvent.isCancelled ? 'cancelled'
      : outlookEvent.showAs === 'tentative' ? 'tentative'
      : 'confirmed';

    return {
      eventId: outlookEvent.id,
      title: outlookEvent.subject || 'No Title',
      description: outlookEvent.bodyPreview || '',
      bodyContent: outlookEvent.body?.content || '',
      startTime: asUtc(outlookEvent.start.dateTime),
      endTime: asUtc(outlookEvent.end.dateTime),
      startTimeZone: allDay ? undefined : 'UTC',
      endTimeZone: allDay ? undefined : 'UTC',
      isAllDay: allDay,
      location: outlookEvent.location?.displayName || '',

      attendees: (outlookEvent.attendees || []).map(attendee => ({
        email: attendee.emailAddress?.address,
        name: attendee.emailAddress?.name,
        responseStatus: ['accepted', 'declined', 'tentative'].includes(attendee.status?.response)
          ? attendee.status.response
          : 'needsAction'
      })),
      organizer: outlookEvent.organizer?.emailAddress ? {
        email: outlookEvent.organizer.emailAddress.address,
        name: outlookEvent.organizer.emailAddress.name
      } : null,

      recurrence: outlookEvent.recurrence ? JSON.stringify(outlookEvent.recurrence) : null,
      status,
      visibility: ['public', 'private', 'confidential'].includes(outlookEvent.sensitivity) ? outlookEvent.sensitivity : 'default',
      source: 'outlook',
      calendarName,
      isHoliday,

      rawData: {
        ...outlookEvent,
        body: outlookEvent.body
      }
    };
  }

  /**
   * Transform Gmail event to our format
   */
  transformGmailEvent(gmailEvent, email, { calendarName = '', isHoliday = false } = {}) {
    return {
      eventId: `${gmailEvent.id}`,
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
      source: 'gmail',
      calendarName,
      isHoliday
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
      const end = endDate || new Date(now.getFullYear(), now.getMonth() + 2, 0);

      const events = await CalendarEvent.find({
        emailAccount: email,
        worxstreamUserId,
        startTime: { $lt: end },
        endTime: { $gte: start }
      }).sort({ startTime: 1 }).lean();

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
