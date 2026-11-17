import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const connectDB = async () => {
  try {
    // Use the provided connection string with mailAgent database
    const uri = process.env.MONGODB_URI;
    
    console.log('🔗 Connecting to MongoDB...');
    console.log('📊 Database: mailAgent');
    
    const conn = await mongoose.connect(uri, {
      // MongoDB connection options
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    
    console.log(`📦 MongoDB Connected: ${conn.connection.host}`);
    console.log(`📊 Database: ${conn.connection.name}`);
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    console.error('🔍 Please check your connection string and network access');
    process.exit(1);
  }
};

export default connectDB;
