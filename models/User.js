// models/User.js
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  passwordHash: {
    type: String,
    required: true
  },
  appUserId: {
    type: String,
    unique: true,
    default: uuidv4
  },
  categories: {
    type: [{
      name: { type: String, required: true },
      label: { type: String, required: true },
      description: { type: String, required: true },
      color: { type: String, default: '#8884D8' },
      createdAt: { type: Date, default: Date.now }
    }],
    default: [
      { 
        name: 'urgent_high_priority', 
        label: 'Urgent & High-Priority',
        description: 'Critical internal or external action items that require immediate attention',
        color: '#FF4444' 
      },
      { 
        name: 'revenue_impacting', 
        label: 'Revenue-Impacting',
        description: 'Payments, invoices, proposals, and other financial matters',
        color: '#00C851' 
      },
      { 
        name: 'customer_sales_ops', 
        label: 'Customer & Sales Ops',
        description: 'Client issues, orders, escalations, and customer service matters',
        color: '#33B5E5' 
      },
      { 
        name: 'growth_strategy', 
        label: 'Growth & Strategy',
        description: 'Partnerships, investors, new ventures, and strategic initiatives',
        color: '#FF8800' 
      },
      { 
        name: 'team_leadership', 
        label: 'Team & Leadership',
        description: 'Hiring, feedback, reviews, and team management matters',
        color: '#9933CC' 
      },
      { 
        name: 'product_technical', 
        label: 'Product & Technical',
        description: 'Dev issues, tech alerts, system notices, and technical matters',
        color: '#4285F4' 
      },
      { 
        name: 'legal_compliance', 
        label: 'Legal & Compliance',
        description: 'Contracts, policies, law firms, and compliance matters',
        color: '#FF6B6B' 
      },
      { 
        name: 'time_sensitive_calendar', 
        label: 'Time-Sensitive Calendar',
        description: 'Calendar invites, meetings, reminders, and time-sensitive events',
        color: '#FFC107' 
      },
      { 
        name: 'newsletters_subscriptions', 
        label: 'Newsletters & Subscriptions',
        description: 'Blogs, Substack, trends, and subscription content',
        color: '#9C27B0' 
      },
      { 
        name: 'vendors_tools', 
        label: 'Vendors & Tools',
        description: 'SaaS usage alerts, renewals, system updates, and vendor communications',
        color: '#607D8B' 
      },
      { 
        name: 'reports_kpis', 
        label: 'Reports & KPIs',
        description: 'Analytics, performance dashboards, and reporting data',
        color: '#795548' 
      },
      { 
        name: 'personal_internal_casual', 
        label: 'Personal/Internal Casual',
        description: 'Non-urgent conversations, casual team communications',
        color: '#E0E0E0' 
      },
      { 
        name: 'archive_low_relevance', 
        label: 'Archive & Low Relevance',
        description: 'Promotions, cold outreach, unsubscribe-able emails, and low-priority content',
        color: '#BDBDBD' 
      },
      {
        name: 'other',
        label: 'Other/Uncategorized',
        description: 'Other categories',
        color: '#000000'
      }
    ]
  }
}, {
  timestamps: true
});

export default mongoose.model('User', userSchema);
