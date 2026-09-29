const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Configure Multer Storage for Sovereign Media Uploads
const uploadDir = path.join(__dirname, '../../public/uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `SOC_${uniqueSuffix}${path.extname(file.originalname)}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 200 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('video/') || file.mimetype.startsWith('image/') || file.mimetype.startsWith('audio/')) {
            cb(null, true);
        } else {
            cb(new Error('SECURITY_VIOLATION: Only verified assets permitted.'), false);
        }
    }
});

const dbFilePath = path.join(__dirname, '../../data/users_db.json');
const postsFilePath = path.join(__dirname, '../../data/posts_db.json');

if (!fs.existsSync(path.dirname(dbFilePath))) {
    fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });
}

function loadUsersDB() {
    try {
        if (fs.existsSync(dbFilePath)) {
            return JSON.parse(fs.readFileSync(dbFilePath, 'utf8'));
        }
    } catch (err) {}
    return {};
}

function saveUsersDB(data) {
    try {
        fs.writeFileSync(dbFilePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {}
}

function loadPostsDB() {
    try {
        if (fs.existsSync(postsFilePath)) {
            return JSON.parse(fs.readFileSync(postsFilePath, 'utf8'));
        }
    } catch (err) {}
    return [
        {
            id: 'POST_001',
            authorName: 'Robert Maina',
            authorHandle: '@robert_maina',
            authorAvatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150',
            caption: 'Welcome to RDS Sovereign! Connect safely.',
            mediaType: 'Video Clip',
            targetVertical: 'MOTIVATION',
            mediaUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
            status: 'APPROVED',
            shares: 42,
            likes: 310,
            timestamp: Date.now()
        }
    ];
}

function savePostsDB(posts) {
    try {
        fs.writeFileSync(postsFilePath, JSON.stringify(posts, null, 2), 'utf8');
    } catch (err) {}
}

let registeredUsers = loadUsersDB();
let socialPosts = loadPostsDB();
let pendingOtps = {};
let postComments = {};

let ioInstance = null;
router.setSocketIo = (io) => {
    ioInstance = io;
    io.on('connection', (socket) => {
        socket.on('video-offer', (data) => { socket.broadcast.emit('video-offer', { offer: data.offer, sender: socket.id }); });
        socket.on('video-answer', (data) => { socket.broadcast.emit('video-answer', { answer: data.answer, sender: socket.id }); });
        socket.on('ice-candidate', (data) => { socket.broadcast.emit('ice-candidate', { candidate: data.candidate, sender: socket.id }); });
        socket.on('call-ended', () => { socket.broadcast.emit('call-ended'); });
    });
};

router.get('/list', (req, res) => {
    res.json({ success: true, advertisements: socialPosts, comments: postComments });
});

router.post('/auth/dispatch-otp', async (req, res) => {
    const { contactId } = req.body; 
    if (!contactId) return res.status(400).json({ success: false, error: "Identifier required." });
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    pendingOtps[contactId] = { code: otpCode, expiresAt: Date.now() + 5 * 60 * 1000 };
    res.json({ success: true, otpCode: otpCode, message: `Code: ${otpCode}` });
});

router.post('/auth/verify-security-challenge', async (req, res) => {
    const { contactId, otpCode, fullName, handle } = req.body;
    const record = pendingOtps[contactId];
    if (!record || record.expiresAt < Date.now() || record.code !== otpCode) {
        return res.status(400).json({ success: false, error: "Invalid or expired code." });
    }
    delete pendingOtps[contactId];

    registeredUsers = loadUsersDB();
    let user = registeredUsers[contactId];
    if (!user) {
        const sessionToken = `SOV_TOKEN_${crypto.randomBytes(32).toString('hex')}`;
        user = { contactId, fullName: fullName || 'User', handle: handle || '@user', sessionToken, createdAt: Date.now() };
        registeredUsers[contactId] = user;
        saveUsersDB(registeredUsers);
    } else {
        if (fullName) user.fullName = fullName;
        if (handle) user.handle = handle;
        saveUsersDB(registeredUsers);
    }

    res.json({ success: true, sessionToken: user.sessionToken, user });
});

router.post('/auth/session-validate', (req, res) => {
    const { contactId, sessionToken } = req.body;
    registeredUsers = loadUsersDB();
    const user = registeredUsers[contactId];
    if (user && user.sessionToken === sessionToken) {
        return res.json({ success: true, user });
    }
    res.status(401).json({ success: false, error: "Invalid session." });
});

router.post('/auth/delete-account', (req, res) => {
    const { contactId, sessionToken } = req.body;
    registeredUsers = loadUsersDB();
    const user = registeredUsers[contactId];
    if (!user || user.sessionToken !== sessionToken) {
        return res.status(403).json({ success: false, error: "Unauthorized." });
    }

    socialPosts = socialPosts.filter(p => p.authorHandle !== user.handle);
    savePostsDB(socialPosts);
    delete registeredUsers[contactId];
    saveUsersDB(registeredUsers);

    res.json({ success: true, message: "Account deleted." });
});

router.post('/media/upload-file', upload.single('mediaFile'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: "No file." });
        const fileUrl = `/uploads/${req.file.filename}`;
        res.json({ success: true, fileUrl });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/media/upload-snapshot', async (req, res) => {
    try {
        const { imageBase64 } = req.body;
        if (!imageBase64) return res.status(400).json({ success: false, error: "No image." });
        const matches = imageBase64.match(/^data:image\/([A-Za-z-+\/]+);base64,(.+)$/);
        const imageBuffer = Buffer.from(matches[2], 'base64');
        const fileName = `SNAP_${Date.now()}.jpg`;
        fs.writeFileSync(path.join(uploadDir, fileName), imageBuffer);
        res.json({ success: true, fileUrl: `/uploads/${fileName}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/media/ingest', async (req, res) => {
    const { title, subtitle, targetVertical, rawMediaUrl, mediaType, authorName, authorHandle } = req.body;

    const newPost = {
        id: `POST_${Date.now()}`,
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
    savePostsDB(socialPosts);
    postComments[newPost.id] = [];

    if (ioInstance) ioInstance.emit('ad_moderated', newPost);
    res.json({ success: true, ad: newPost });
});

router.post('/telemetry', async (req, res) => {
    const { adId, action } = req.body;
    const post = socialPosts.find(p => p.id === adId);
    if (!post) return res.status(404).json({ success: false, error: "Not found." });

    if (action === 'like') post.likes = (post.likes || 0) + 1;
    savePostsDB(socialPosts);

    if (ioInstance) ioInstance.emit('telemetry_update', { adId: post.id, likes: post.likes, shares: post.shares });
    res.json({ success: true, ad: post });
});

module.exports = router;