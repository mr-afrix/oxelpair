import express from 'express';
import fs from 'fs-extra';
import pino from 'pino';
import pn from 'awesome-phonenumber';
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
    DisconnectReason
} from '@itsliaaa/baileys';
import { encodeSession } from './session.js';
import { sendSessionMessage } from './lib/message.js';

const router = express.Router();

const MAX_RECONNECT_ATTEMPTS = 3;
const SESSION_TIMEOUT        = 5 * 60 * 1000;
const CLEANUP_DELAY          = 5000;

async function removeFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return false;
        await fs.remove(filePath);
        return true;
    } catch (e) {
        return false;
    }
}

router.get('/', async (req, res) => {
    let num = req.query.number;
    if (!num) return res.status(400).json({ error: 'Phone number is required' });

    num = num.replace(/[^0-9]/g, '');
    const phone = pn('+' + num);
    if (!phone.isValid()) return res.status(400).json({ error: 'Invalid phone number' });
    num = phone.getNumber('e164').replace('+', '');

    const sessionId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    const dirs      = `./auth_info_baileys/session_${sessionId}`;

    let pairingCodeSent   = false;
    let sessionCompleted  = false;
    let isCleaningUp      = false;
    let responseSent      = false;
    let reconnectAttempts = 0;
    let currentSocket     = null;
    let timeoutHandle     = null;

    async function cleanup(reason) {
        if (isCleaningUp) return;
        isCleaningUp = true;
        if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
        if (currentSocket) {
            try { currentSocket.ev.removeAllListeners(); } catch (e) {}
            if (reason !== 'session_complete') {
                try { await currentSocket.end(); } catch (e) {}
            }
            currentSocket = null;
        }
        setTimeout(async () => { await removeFile(dirs); }, CLEANUP_DELAY);
    }

    async function initiateSession() {
        if (sessionCompleted || isCleaningUp) return;
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            if (!responseSent && !res.headersSent) {
                responseSent = true;
                res.status(503).json({ error: 'Connection failed after multiple attempts' });
            }
            await cleanup('max_reconnects');
            return;
        }

        try {
            if (!fs.existsSync(dirs)) await fs.mkdir(dirs, { recursive: true });
            const { state, saveCreds } = await useMultiFileAuthState(dirs);
            const { version }          = await fetchLatestBaileysVersion();

            if (currentSocket) {
                try { currentSocket.ev.removeAllListeners(); await currentSocket.end(); } catch (e) {}
            }

            currentSocket = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys:  makeCacheableSignalKeyStore(
                        state.keys,
                        pino({ level: 'fatal' }).child({ level: 'fatal' })
                    )
                },
                printQRInTerminal:          false,
                logger:                     pino({ level: 'silent' }),
                browser:                    Browsers.ubuntu('Chrome'),
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
                const { connection, lastDisconnect } = update;

                if (connection === 'open') {
                    if (sessionCompleted) return;
                    sessionCompleted = true;
                    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
                    try {
                        const credsFile = `${dirs}/creds.json`;
                        if (fs.existsSync(credsFile)) {
                            const credsBuffer  = await fs.readFile(credsFile);
                            const sageSession  = encodeSession(credsBuffer);
                            const userJid      = jidNormalizedUser(num + '@s.whatsapp.net');
                            await sendSessionMessage(sock, userJid, sageSession);
                        }
                    } catch (err) {
                        console.error('Error sending session message:', err.message);
                    } finally {
                        await cleanup('session_complete');
                    }
                }

                if (connection === 'close') {
                    if (sessionCompleted || isCleaningUp) { await cleanup('already_complete'); return; }
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                        if (!responseSent && !res.headersSent) {
                            responseSent = true;
                            res.status(401).json({ error: 'Invalid pairing code or session expired' });
                        }
                        await cleanup('logged_out');
                    } else if (pairingCodeSent && !sessionCompleted) {
                        reconnectAttempts++;
                        await delay(2000);
                        await initiateSession();
                    } else {
                        await cleanup('connection_closed');
                    }
                }
            });

            if (!sock.authState.creds.registered && !pairingCodeSent && !isCleaningUp) {
                await delay(1500);
                try {
                    pairingCodeSent = true;
                    let code = await sock.requestPairingCode(num, 'OXELLABS');
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    if (!responseSent && !res.headersSent) {
                        responseSent = true;
                        res.json({ code });
                    }
                } catch (error) {
                    pairingCodeSent = false;
                    if (!responseSent && !res.headersSent) {
                        responseSent = true;
                        res.status(503).json({ error: 'Failed to get pairing code' });
                    }
                    await cleanup('pairing_code_error');
                }
            }

            sock.ev.on('creds.update', saveCreds);

            timeoutHandle = setTimeout(async () => {
                if (!sessionCompleted && !isCleaningUp) {
                    if (!responseSent && !res.headersSent) {
                        responseSent = true;
                        res.status(408).json({ error: 'Pairing timeout' });
                    }
                    await cleanup('timeout');
                }
            }, SESSION_TIMEOUT);

        } catch (err) {
            console.error('Error initializing pair session:', err.message);
            if (!responseSent && !res.headersSent) {
                responseSent = true;
                res.status(503).json({ error: 'Service unavailable' });
            }
            await cleanup('init_error');
        }
    }

    await initiateSession();
});

setInterval(async () => {
    try {
        const baseDir = './auth_info_baileys';
        if (!fs.existsSync(baseDir)) return;
        const sessions = await fs.readdir(baseDir);
        const now = Date.now();
        for (const session of sessions) {
            try {
                const stats = await fs.stat(`${baseDir}/${session}`);
                if (now - stats.mtimeMs > 10 * 60 * 1000) await fs.remove(`${baseDir}/${session}`);
            } catch (e) {}
        }
    } catch (e) {}
}, 60000);

process.on('SIGTERM', async () => { try { await fs.remove('./auth_info_baileys'); } catch (e) {} process.exit(0); });
process.on('SIGINT',  async () => { try { await fs.remove('./auth_info_baileys'); } catch (e) {} process.exit(0); });
process.on('uncaughtException', (err) => {
    const e = String(err);
    const ignore = ['conflict', 'not-authorized', 'Socket connection timeout', 'rate-overlimit',
                    'Connection Closed', 'Timed Out', 'Value not found', 'Stream Errored',
                    'statusCode: 515', 'statusCode: 503'];
    if (!ignore.some(x => e.includes(x))) console.error('Uncaught exception:', err);
});

export default router;
