import https from 'https';

const BOT_NAME         = '𝐎xᴇʟ 𝐁ᴏᴛ;
const BOT_REPO         = 'https://github.com/mr-afrix';
const WHATSAPP_CHANNEL = 'https://whatsapp.com/channel/0029VbC5z6RK0IBpyUjyof0J';
const BANNER_URL       = 'https://raw.githubusercontent.com/mr-afrix/sage-session/main/banner.png';
const NEWSLETTER_JID   = '120363408935865710@newsletter';

const FALLBACK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAyAAAADICAIAAACf7RJNAAADpUlEQVR4nO3WUQkAIBTAwFfABDawf0BLDAQ5uAD73Kx9AAAIzfMCAIDPGCwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIGSwAgJjBAgCIXTNtPblkVMJQAAAAAElFTkSuQmCC',
    'base64'
);

function fetchBuffer(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            const contentType = res.headers['content-type'] || '';
            if (!contentType.startsWith('image/')) {
                res.destroy();
                return reject(new Error(`Bad content-type: ${contentType}`));
            }
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(8000, () => { req.destroy(); reject(new Error('Banner fetch timeout')); });
    });
}

let _bannerCache = null;
async function getBanner() {
    if (_bannerCache) return _bannerCache;
    try {
        const buf = await fetchBuffer(BANNER_URL);
        _bannerCache = buf;
        return buf;
    } catch (e) {
        console.warn('Banner fetch failed, using fallback:', e.message);
        return FALLBACK_PNG;
    }
}

export async function sendSessionMessage(sock, jid, sessionId) {
    const bannerBuffer = await getBanner();

    await sock.sendMessage(jid, {
        image: bannerBuffer,
        caption: `𝐎𝐗𝐄𝐋 𝐁𝐎𝐓 𝐒𝐄𝐒𝐒𝐈𝐎𝐍\n\n${sessionId}`,
        footer: `ᴏxᴇʟ ʙᴏᴛ ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴏxᴇʟʟᴀʙs`,

        nativeFlow: [
            { text: '📋 𝐂𝐎𝐏𝐘 𝐒𝐄𝐒𝐒𝐈𝐎𝐍', copy: sessionId },
            { text: '📦 𝐁𝐎𝐓 𝐑𝐄𝐏𝐎', url: BOT_REPO, useWebview: true },
            { text: '📢 𝐖𝐀 𝐂𝐇𝐀𝐍𝐍𝐄𝐋', url: WHATSAPP_CHANNEL, useWebview: true }
        ],

        externalAdReply: {
            title: BOT_NAME,
            body: 'WhatsApp · Verified',
            url: WHATSAPP_CHANNEL,
            thumbnail: bannerBuffer,
            mediaType: 1,
            showAdAttribution: true,
            largeThumbnail: false
        },

        contextInfo: {
            forwardedNewsletterMessageInfo: {
                newsletterJid: NEWSLETTER_JID,
                newsletterName: BOT_NAME,
                serverMessageId: Math.floor(Math.random() * 999999)
            },
            isForwarded: true,
            forwardingScore: 999
        }
    });
}
