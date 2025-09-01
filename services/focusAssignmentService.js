// services/focusAssignmentService.js
import EmailAccount from '../models/EmailAccount.js';
import Email from '../models/email.js';
import User from '../models/User.js';
import { updateFocusItemActivity } from '../controllers/focusController.js';

class FocusAssignmentService {
  constructor() {
    this.focusCache = new Map(); // Cache focus items for performance
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
  }

  // Get focus items for a user/email combination (with caching)
  async getFocusItems(userId, email) {
    const cacheKey = `${userId}_${email}`;
    const cached = this.focusCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp) < this.cacheExpiry) {
      return cached.data;
    }

    try {
      const emailAccount = await EmailAccount.findOne({ userId, email });
      const focusItems = emailAccount?.focusedItems || [];
      
      // Cache the result
      this.focusCache.set(cacheKey, {
        data: focusItems,
        timestamp: Date.now()
      });
      
      return focusItems;
    } catch (error) {
      console.error('❌ Error getting focus items:', error);
      return [];
    }
  }

  // Check if an email matches any focus criteria and assign focus folder
  async assignFocusFolder(emailData, userId, email) {
    try {
      const focusItems = await this.getFocusItems(userId, email);
      if (!focusItems || focusItems.length === 0) {
        return null; // No focus items to check
      }

      let assignedFocusFolder = null;

      for (const focusItem of focusItems) {
        if (!focusItem.isActive) continue;

        let isMatch = false;

        if (focusItem.type === 'subject') {
          // Check if email subject matches focus criteria
          isMatch = this.matchSubject(emailData.subject, focusItem.value);
        } else if (focusItem.type === 'email') {
          // Check if email address appears in from/to/cc/bcc
          isMatch = this.matchEmailAddress(emailData, focusItem.value);
        }

        if (isMatch) {
          assignedFocusFolder = focusItem.folderName;
          console.log(`🎯 Email ${emailData.id} assigned to focus folder: ${assignedFocusFolder}`);
          
          // Update focus item activity
          await updateFocusItemActivity(userId, email, assignedFocusFolder);
          break; // Use first match
        }
      }

      return assignedFocusFolder;
    } catch (error) {
      console.error('❌ Error assigning focus folder:', error);
      return null;
    }
  }

  // Check if subject matches focus criteria
  matchSubject(emailSubject, focusSubject) {
    if (!emailSubject || !focusSubject) return false;
    
    // Convert to lowercase for case-insensitive comparison
    const emailSubjectLower = emailSubject.toLowerCase();
    const focusSubjectLower = focusSubject.toLowerCase();
    
    // Check for exact match or contains
    return emailSubjectLower === focusSubjectLower || 
           emailSubjectLower.includes(focusSubjectLower) ||
           focusSubjectLower.includes(emailSubjectLower);
  }

  // Check if email address appears in email data
  matchEmailAddress(emailData, focusEmail) {
    if (!focusEmail) return false;
    
    const focusEmailLower = focusEmail.toLowerCase();
    
    // Check from field
    if (emailData.from && emailData.from.toLowerCase().includes(focusEmailLower)) {
      return true;
    }
    
    // Check to field
    if (emailData.to && emailData.to.toLowerCase().includes(focusEmailLower)) {
      return true;
    }
    
    // Check cc field
    if (emailData.cc && emailData.cc.toLowerCase().includes(focusEmailLower)) {
      return true;
    }
    
    // Check bcc field
    if (emailData.bcc && emailData.bcc.toLowerCase().includes(focusEmailLower)) {
      return true;
    }
    
    return false;
  }

  // Clear cache for a specific user/email combination
  clearCache(userId, email) {
    const cacheKey = `${userId}_${email}`;
    this.focusCache.delete(cacheKey);
  }

  // Clear all cache
  clearAllCache() {
    this.focusCache.clear();
  }

  // Update focus folder for an existing email
  async updateEmailFocusFolder(emailId, userId, email, focusFolder) {
    try {
      const result = await Email.findOneAndUpdate(
        { id: emailId, userId, email },
        { focusFolder },
        { new: true }
      );
      
      if (result) {
        console.log(`✅ Updated focus folder for email ${emailId}: ${focusFolder}`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('❌ Error updating email focus folder:', error);
      return false;
    }
  }

  // Get all emails for a specific focus folder
  async getEmailsByFocusFolder(userId, email, focusFolder, page = 1, limit = 20) {
    try {
      const skip = (page - 1) * limit;
      
      const emails = await Email.find({
        userId,
        email,
        focusFolder
      })
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .select('-content'); // Exclude content for performance

      const total = await Email.countDocuments({
        userId,
        email,
        focusFolder
      });

      return {
        emails,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      };
    } catch (error) {
      console.error('❌ Error getting emails by focus folder:', error);
      throw error;
    }
  }

  // Get focus statistics for a user
  async getFocusStatistics(userId, email) {
    try {
      const focusItems = await this.getFocusItems(userId, email);
      const stats = [];

      for (const focusItem of focusItems) {
        const emailCount = await Email.countDocuments({
          userId,
          email,
          focusFolder: focusItem.folderName
        });

        const unreadCount = await Email.countDocuments({
          userId,
          email,
          focusFolder: focusItem.folderName,
          read: false
        });

        stats.push({
          ...focusItem.toObject(),
          emailCount,
          unreadCount
        });
      }

      return stats;
    } catch (error) {
      console.error('❌ Error getting focus statistics:', error);
      return [];
    }
  }
}

const focusAssignmentService = new FocusAssignmentService();
export default focusAssignmentService;
