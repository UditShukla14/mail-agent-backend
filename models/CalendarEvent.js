import mongoose from 'mongoose';

const calendarEventSchema = new mongoose.Schema({
  emailAccount: {
    type: String,
    required: true,
    index: true
  },
  eventId: {
    type: String,
    required: true,
    unique: true
  },
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: ''
  },
  bodyContent: {
    type: String,
    default: ''
  },
  startTime: {
    type: Date,
    required: true
  },
  endTime: {
    type: Date,
    required: true
  },
  isAllDay: {
    type: Boolean,
    default: false
  },
  location: {
    type: String,
    default: ''
  },
  attendees: [{
    email: String,
    name: String,
    responseStatus: {
      type: String,
      enum: ['accepted', 'declined', 'tentative', 'needsAction'],
      default: 'needsAction'
    }
  }],
  organizer: {
    email: String,
    name: String
  },
  recurrence: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ['confirmed', 'tentative', 'cancelled'],
    default: 'confirmed'
  },
  visibility: {
    type: String,
    enum: ['default', 'public', 'private', 'confidential'],
    default: 'default'
  },
  source: {
    type: String,
    enum: ['outlook', 'gmail'],
    required: true
  },
  worxstreamUserId: {
    type: Number,
    required: true,
    index: true
  },
  lastSynced: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Compound index for efficient queries
calendarEventSchema.index({ emailAccount: 1, startTime: 1, endTime: 1 });
calendarEventSchema.index({ worxstreamUserId: 1, startTime: 1 });

const CalendarEvent = mongoose.model('CalendarEvent', calendarEventSchema);

export default CalendarEvent;
