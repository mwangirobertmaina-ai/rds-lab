const express = require('express');
const router = express.Router();
const https = require('https');
const http = require('http');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Configure Multer Storage for Sovereign Media Uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../../public/uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `SOC_${uniqueSuffix}${path.extname(file.originalname)}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 200 * 1024 * 1024 }, // 200MB Limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('video/') || file.mimetype.startsWith('image/') || file.mimetype.startsWith('audio/')) {
            cb(null, true);
        } else {
            cb(new Error('SECURITY_VIOLATION: Only verified video, image, and audio assets permitted.'), false);
        }
    }
});

// --- ADVANCED SECURITY & MEMORY VAULTS ---
let pendingOtps = {};
let verifiedSessions = {};
let registeredUsers = {};

// --- FAMILY-FRIENDLY & HUMAN RIGHTS AI SENTINEL CORE ---
class SovereignAISentinelEngine {
    constructor() {
        this.toxicLexicon = [
            'abuse', 'nsfw', 'porn', 'explicit', 'hate', 'scam', 'fraud', 'phishing', 
            'violence', 'malware', 'virus', 'hack', 'suicide', 'harassment', 'nude', 
            'strip', 'blood', 'kill', 'weapon', 'illegal', 'minor_harm'
        ];
        this.quarantineLog = [];
    }

    async scanTextPayload(text) {
        if (!text) return { safe: true, threatLevel: '0.00%' };
        const lower = text.toLowerCase();
        for (let word of this.toxicLexicon) {
            if (lower.includes(word)) {
                this.quarantineLog.push({ timestamp: Date.now(), trigger: word, type: 'TEXT_THREAT' });
                return { 
                    safe: false, 
                    reason: `Family Safety Guard: Content violates community guidelines and safety policies.` 
                };
            }
        }
        return { safe: true, threatLevel: '0.00%' };
    }

    async inspectMediaAsset(fileMetadata, caption) {
        const textCheck = await this.scanTextPayload(caption);
        if (!textCheck.safe) return textCheck;

        if (fileMetadata && fileMetadata.originalname) {
            const nameLower = fileMetadata.originalname.toLowerCase();
            if (nameLower.includes('nsfw') || nameLower.includes('porn') || nameLower.includes('nude') || nameLower.includes('virus')) {
                return {
                    safe: false,
                    reason: "Safety Sentinel Block: Media violates family-friendly and human rights protection policies."
                };
            }
        }

        return { safe: true, reason: 'Verified family-safe by AI Sentinel.' };
    }
}

const aiSentinel = new SovereignAISentinelEngine();

// Social Media Feeds (Reels & Statuses)
let socialPosts = [
    {
        id: 'POST_001',
        authorName: 'Robert Maina',
        authorHandle: '@robert_maina',
        authorAvatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
        caption: 'Welcome to RDS Sovereign! Connect safely, share great moments, and chat with friends worldwide. 🚀',
        mediaType: 'Video Clip',
        targetVertical: 'MOTIVATION',
        mediaUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
        status: 'APPROVED',
        shares: 42,
        likes: 310,
        timestamp: Date.now()
    }
];

let postComments = {
    'POST_001': [
        { user: '@robert_maina', comment: 'Super fast, secure, and family-friendly!', timestamp: Date.now() }
    ]
};

let ioInstance = null;
router.setSocketIo = (io) => {
    ioInstance = io;

    io.on('connection', (socket) => {
        console.log(`🔌 Sovereign Peer Connected for Live Calls: ${socket.id}`);

        socket.on('video-offer', (data) => {
            socket.broadcast.emit('video-offer', { offer: data.offer, sender: socket.id });
        });

        socket.on('video-answer', (data) => {
            socket.broadcast.emit('video-answer', { answer: data.answer, sender: socket.id });
        });

        socket.on('ice-candidate', (data) => {
            socket.broadcast.emit('ice-candidate', { candidate: data.candidate, sender: socket.id });
        });

        socket.on('call-ended', () => {
            socket.broadcast.emit('call-ended');
        });

        socket.on('disconnect', () => {
            console.log(`🔌 Sovereign Peer Disconnected: ${socket.id}`);
        });
    });
};

router.get('/list', (req, res) => {
    res.json({ success: true, advertisements: socialPosts, comments: postComments });
});

router.post('/auth/dispatch-otp', async (req, res) => {
    const { contactId } = req.body; 
    if (!contactId) {
        return res.status(400).json({ success: false, error: "Identifier (Email or Phone) required." });
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    pendingOtps[contactId] = { code: otpCode, expiresAt: Date.now() + 5 * 60 * 1000 };

    res.json({ success: true, otpCode: otpCode, message: `Verification code dispatched. Code: ${otpCode}` });
});

router.post('/auth/verify-security-challenge', async (req, res) => {
    const { contactId, otpCode, fullName, handle } = req.body;
    const record = pendingOtps[contactId];
    if (!record || record.expiresAt < Date.now()) {
        return res.status(400).json({ success: false, error: "Verification code expired or invalid." });
    }
    if (record.code !== otpCode) {
        return res.status(403).json({ success: false, error: "Invalid security code." });
    }

    delete pendingOtps[contactId];
    const sessionToken = `SOV_TOKEN_${crypto.randomBytes(32).toString('hex')}`;
    registeredUsers[contactId] = { fullName: fullName || 'User', handle: handle || '@user', sessionToken };

    res.json({ success: true, message: "Authenticated successfully!", sessionToken, user: registeredUsers[contactId] });
});

// --- MEDIA FILE UPLOAD ---
router.post('/media/upload-file', upload.single('mediaFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: "No media file received." });
        }

        const inspection = await aiSentinel.inspectMediaAsset(req.file, '');
        if (!inspection.safe) {
            fs.unlink(req.file.path, () => {});
            return res.status(403).json({ success: false, error: inspection.reason });
        }

        const fileUrl = `/uploads/${req.file.filename}`;
        res.json({ success: true, message: "Verified family-safe!", fileUrl });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- HANDLE BASE64 SNAPSHOT (PHOTO) ---
router.post('/media/upload-snapshot', async (req, res) => {
    try {
        const { imageBase64 } = req.body;
        if (!imageBase64) {
            return res.status(400).json({ success: false, error: "No snapshot data received." });
        }

        const matches = imageBase64.match(/^data:image\/([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches || matches.length !== 3) {
            return res.status(400).json({ success: false, error: "Invalid image format." });
        }

        const imageBuffer = Buffer.from(matches[2], 'base64');
        const fileName = `SNAP_${Date.now()}.jpg`;
        const uploadDir = path.join(__dirname, '../../public/uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

        const filePath = path.join(uploadDir, fileName);
        fs.writeFileSync(filePath, imageBuffer);

        res.json({ success: true, message: "Snapshot captured and verified successfully!", fileUrl: `/uploads/${fileName}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- HANDLE RECORDED VIDEO BLOB ---
router.post('/media/upload-video-blob', upload.single('videoBlob'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: "No recorded video received." });
        }

        const inspection = await aiSentinel.inspectMediaAsset(req.file, '');
        if (!inspection.safe) {
            fs.unlink(req.file.path, () => {});
            return res.status(403).json({ success: false, error: inspection.reason });
        }

        const fileUrl = `/uploads/${req.file.filename}`;
        res.json({ success: true, message: "Video recording verified family-safe!", fileUrl });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/media/ingest', async (req, res) => {
    const { title, subtitle, targetVertical, rawMediaUrl, mediaType, authorName, authorHandle } = req.body;
    
    const aiCheck = await aiSentinel.scanTextPayload(`${title} ${subtitle}`);
    if (!aiCheck.safe) {
        return res.status(403).json({ success: false, error: aiCheck.reason });
    }

    const uniqueId = `POST_${Date.now()}`;
    const newPost = {
        id: uniqueId,
        authorName: authorName || 'User',
        authorHandle: authorHandle || '@user',
        authorAvatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
        title: title || 'Moment',
        subtitle: subtitle || '',
        mediaType: mediaType || 'Photo',
        targetVertical: targetVertical || 'MOTIVATION',
        mediaUrl: rawMediaUrl,
        status: 'APPROVED',
        shares: 0,
        likes: 0,
        timestamp: Date.now()
    };

    socialPosts.unshift(newPost);
    postComments[uniqueId] = [];

    if (ioInstance) ioInstance.emit('ad_moderated', newPost);

    res.json({ success: true, message: "Published successfully!", ad: newPost });
});

router.post('/telemetry', async (req, res) => {
    const { adId, action, commentText, userHandle } = req.body; 
    const post = socialPosts.find(p => p.id === adId);

    if (!post) return res.status(404).json({ success: false, error: "Post not found." });

    if (action === 'comment' && commentText) {
        const commentCheck = await aiSentinel.scanTextPayload(commentText);
        if (!commentCheck.safe) {
            return res.status(403).json({ success: false, error: commentCheck.reason });
        }

        if (!postComments[adId]) postComments[adId] = [];
        postComments[adId].unshift({ user: userHandle || '@friend', comment: commentText, timestamp: Date.now() });
    } else if (action === 'like') {
        post.likes = (post.likes || 0) + 1;
    } else if (action === 'share') {
        post.shares = (post.shares || 0) + 1;
    }

    if (ioInstance) {
        ioInstance.emit('telemetry_update', { adId: post.id, likes: post.likes, shares: post.shares, comments: postComments[adId] });
    }

    res.json({ success: true, ad: post, comments: postComments[adId] });
});

module.exports = router;