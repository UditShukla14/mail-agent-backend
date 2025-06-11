import mongoose from "mongoose";
const tokenSchema = new mongoose.Schema({
    appUserId: {
        type:String,
        required:true,
    },
    email: {
        type:String,
        required:true,
    },
    provider:{
        type:String,
        required:true,
        enum:["gmail","outlook"],
    },
    access_token: {
        type:String,
    },
    refresh_token: {
        type:String,
    },
    expires_in: {
        type:Number,
    },
    timestamp: {
        type:Number,
    },
},
{timestamps:true}
);

tokenSchema.index({ appUserId: 1, email: 1, provider: 1 }, { unique: true });

export default mongoose.model('Token', tokenSchema);
