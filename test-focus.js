// test-focus.js - Simple test script for Focus feature
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import EmailAccount from './models/EmailAccount.js';
import Email from './models/email.js';
import User from './models/User.js';
import focusAssignmentService from './services/focusAssignmentService.js';

dotenv.config();

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mailAgent');
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Test focus feature
const testFocusFeature = async () => {
  try {
    console.log('🧪 Testing Focus Feature...\n');

    // Create a test user
    const testUser = new User({
      email: 'test@example.com',
      worxstreamUserId: 99999,
      name: 'Test User'
    });
    await testUser.save();
    console.log('✅ Test user created');

    // Create a test email account with focus items
    const testEmailAccount = new EmailAccount({
      userId: testUser._id,
      email: 'test@example.com',
      provider: 'outlook',
      focusedItems: [
        {
          type: 'subject',
          value: 'Project Update',
          folderName: 'focus_subject_project_update_123456',
          createdAt: new Date(),
          lastActivity: new Date(),
          emailCount: 0,
          isActive: true
        },
        {
          type: 'email',
          value: 'client@company.com',
          folderName: 'focus_email_client_company_com_654321',
          createdAt: new Date(),
          lastActivity: new Date(),
          emailCount: 0,
          isActive: true
        }
      ]
    });
    await testEmailAccount.save();
    console.log('✅ Test email account created with focus items');

    // Test focus assignment service
    console.log('\n🔍 Testing focus assignment...');
    
    const testEmail1 = {
      id: 'test-email-1',
      subject: 'Project Update - Phase 1 Complete',
      from: 'team@company.com',
      to: 'test@example.com',
      cc: '',
      bcc: ''
    };

    const testEmail2 = {
      id: 'test-email-2',
      subject: 'Weekly Report',
      from: 'client@company.com',
      to: 'test@example.com',
      cc: '',
      bcc: ''
    };

    const focusFolder1 = await focusAssignmentService.assignFocusFolder(
      testEmail1, 
      testUser._id, 
      'test@example.com'
    );
    console.log(`📧 Email 1 focus folder: ${focusFolder1}`);

    const focusFolder2 = await focusAssignmentService.assignFocusFolder(
      testEmail2, 
      testUser._id, 
      'test@example.com'
    );
    console.log(`📧 Email 2 focus folder: ${focusFolder2}`);

    // Test focus statistics
    console.log('\n📊 Testing focus statistics...');
    const stats = await focusAssignmentService.getFocusStatistics(
      testUser._id, 
      'test@example.com'
    );
    console.log('Focus statistics:', JSON.stringify(stats, null, 2));

    // Clean up test data
    console.log('\n🧹 Cleaning up test data...');
    await Email.deleteMany({ userId: testUser._id });
    await EmailAccount.deleteOne({ userId: testUser._id });
    await User.deleteOne({ _id: testUser._id });
    console.log('✅ Test data cleaned up');

    console.log('\n🎉 Focus feature test completed successfully!');
  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
};

// Run the test
if (import.meta.url === `file://${process.argv[1]}`) {
  connectDB().then(testFocusFeature);
}
