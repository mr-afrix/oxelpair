import express from 'express';
import fs from 'fs-extra';
import pino from 'pino';
import QRCode from 'qrcode';
import {
    makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
    delay,
    DisconnectReason
} from '@itsliaaa/baileys';
import { encodeSession } from './session.js';
import { sendSessionMessage } from './lib/message.js';

const router = express.Router();

const MAX_RECONNECT_ATTEMPTS = 3;
const SESSION_TIMEOUT        = 60000;

async function removeFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return;
        await fs.remove(filePath);
    } catch {}
}

router.get('/', async (req, res) => {
    const sessionId = `${Date.now()}${Math.random().toString(36).slice(2, 9)}`;
    const dirs      = `./qr_sessions/session_${sessionId}`;
    await fs.mkdir(dirs, { recursive: true });

    let qrGenerated       = false;
    let sessionCompleted  = false;
    let responseSent      = false;
    let reconnectAttempts = 0;
    let currentSocket     = null;
    let timeoutHandle     = null;
    let isCleaningUp      = false;

    async function cleanup(reason) {
        if (isCleaningUp) return;
        isCleaningUp = true;
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        if (currentSocket) {
            try { currentSocket.ev.removeAllListeners(); } catch {}
            if (reason !== 'session_complete') {
                try { await currentSocket.end(); } catch {}
            }
            currentSocket = null;
        }
        setTimeout(() => removeFile(dirs), 5000);
    }

    async function initiateSession() {
        if (sessionCompleted || isCleaningUp) return;
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            if (!responseSent && !res.headersSent) {
                responseSent = true;
                res.status(503).json({ error: 'Connection failed after multiple attempts' });
            }
            await cleanup();
            return;
        }

        await fs.mkdir(dirs, { recursive: true });
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version } = await fetchLatestBaileysVersion();

            if (currentSocket) {
                try { currentSocket.ev.removeAllListeners(); await currentSocket.end(); } catch {}
            }

            currentSocket = makeWASocket({
                version,
                logger:  pino({ level: 'silent' }),
                browser: Browsers.ubuntu('Chrome'),
                auth: {
                    creds: state.creds,
                    keys:  makeCacheableSignalKeyStore(
                        state.keys,
                        pino({ level: 'fatal' }).child({ level: 'fatal' })
                    )
                },
                printQRInTerminal:          false,
                markOnlineOnConnect:        false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs:      60000,
                connectTimeoutMs:           60000,
                keepAliveIntervalMs:        30000,
                retryRequestDelayMs:        250,
                maxRetries:                 3
            });

            const sock = currentSocket;

            sock.ev.on('connection.update', async (update) => {
                if (isCleaningUp) return;
                const { connection, lastDisconnect, qr } = update;

                if (qr && !qrGenerated && !sessionCompleted) {
                    qrGenerated = true;
                    try {
                        const qrDataURL = await QRCode.toDataURL(qr, {
                            errorCorrectionLevel: 'M',
                            color: { dark: '#ffffff', light: '#0d1b2a' },
                            margin: 2
                        });
                        if (!responseSent && !res.headersSent) {
                            responseSent = true;
                            res.json({ qr: qrDataURL });
                        }
                    } catch (err) {
                        console.error('QR generation error:', err.message);
                        if (!responseSent && !res.headersSent) {
                            responseSent = true;
                            res.status(500).json({ error: 'Failed to generate QR code' });
                        }
                        await cleanup();
                    }
                }

                if (connection === 'open') {
                    if (sessionCompleted) return;
                    sessionCompleted = true;
                    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
                    try {
                        const credsFile = `${dirs}/creds.json`;
                        if (fs.existsSync(credsFile)) {
                            const credsBuffer = await fs.readFile(credsFile);
                            const sageSession = encodeSession(credsBuffer);
                            const userJid     = jidNormalizedUser(sock.authState.creds.me.id);
                            await sendSessionMessage(sock, userJid, sageSession);
                        }
                    } catch (err) {
                        console.error('Error sending session message:', err.message);
                    } finally {
                        await cleanup('session_complete');
                    }
                }

                if (connection === 'close') {
                    if (sessionCompleted || isCleaningUp) { await cleanup(); return; }
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                        if (!responseSent && !res.headersSent) {
                            responseSent = true;
                            res.status(401).json({ error: 'Invalid QR scan or session expired' });
                        }
                        await cleanup();
                    } else if (qrGenerated && !sessionCompleted) {
                        reconnectAttempts++;
                        await delay(2000);
                        await initiateSession();
                    } else {
                        await cleanup();
                    }
                }
            });

            sock.ev.on('creds.update', saveCreds);

            timeoutHandle = setTimeout(async () => {
                if (!sessionCompleted && !isCleaningUp) {
                    if (!responseSent && !res.headersSent) {
                        responseSent = true;
                        res.status(408).json({ error: 'QR generation timeout' });
                    }
                    await cleanup();
                }
            }, SESSION_TIMEOUT);

        } catch (err) {
            console.error('Error initializing QR session:', err.message);
            if (!responseSent && !res.headersSent) {
                responseSent = true;
                res.status(503).json({ error: 'Service unavailable' });
            }
            await cleanup();
        }
    }

    await initiateSession();
});

setInterval(async () => {
    try {
        if (!fs.existsSync('./qr_sessions')) return;
        const sessions = await fs.readdir('./qr_sessions');
        const now = Date.now();
        for (const session of sessions) {
            try {
                const stats = await fs.stat(`./qr_sessions/${session}`);
                if (now - stats.mtimeMs > 300000) await fs.remove(`./qr_sessions/${session}`);
            } catch {}
        }
    } catch {}
}, 60000);

process.on('uncaughtException', (err) => {
    const e = String(err);
    const ignore = ['conflict', 'not-authorized', 'Socket connection timeout', 'rate-overlimit',
                    'Connection Closed', 'Timed Out', 'Value not found', 'Stream Errored',
                    'statusCode: 515', 'statusCode: 503'];
    if (!ignore.some(x => e.includes(x))) console.error('Uncaught exception:', err);
});

export default router;
