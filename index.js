import express from 'express';
import bodyParser from 'body-parser';
import { EventEmitter } from 'events';
import pairRouter from './pair.js';
import qrRouter from './qr.js';

EventEmitter.defaultMaxListeners = 500;

const app = express();

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

app.use('/code', pairRouter);
app.use('/qr', qrRouter);

app.listen(8000, () => {
    console.log('Server running on port 8000');
});

export default app;
