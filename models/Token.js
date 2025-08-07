import mongoose from "mongoose";
const tokenSchema = new mongoose.Schema({
    worxstreamUserId: {
        type: Number,
        required: true,
    },
    email: {
        type: String,
        required: true,
    },
    provider:{
        type: String,
        required: true,
        enum: ["gmail", "outlook"],
    },
    access_token: {
        type: String,
        required: true,
    },
    refresh_token: {
        type: String,
        required: true,
    },
    expires_in: {
        type: Number,
        required: true,
    },
    timestamp: {
        type: Number,
        required: true,
    },
},
{timestamps: true}
);

tokenSchema.index({ worxstreamUserId: 1, email: 1, provider: 1 }, { unique: true });

export default mongoose.model('Token', tokenSchema);
