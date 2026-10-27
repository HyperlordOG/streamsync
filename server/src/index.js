import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ENV_FILE = path.join(__dirname, '..', '.env');

// Load .env if present
if (fs.existsSync(ENV_FILE)) {
  const envContent = fs.readFileSync(ENV_FILE, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

import { registerRoutes } from './routes/index.js';
import { registerWsServer } from './ws/server.js';

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';

async function bootstrap() {
  const fastify = Fastify({
    logger: {
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
      },
    },
  });

  // ── Plugins ──────────────────────────────────────────────────────────────
  await fastify.register(fastifyCors, {
    origin: true, // Lock down to specific domains in production
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  });

  await fastify.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
  });

  await fastify.register(fastifyWebsocket);

  // ── Web App Routes ────────────────────────────────────────────────────────
  fastify.get('/party/:id', async (req, reply) => {
    return reply.sendFile('index.html');
  });

  // ── API & WS Routes ───────────────────────────────────────────────────────
  await fastify.register(registerRoutes);
  await fastify.register(registerWsServer);

  // ── Start ─────────────────────────────────────────────────────────────────
  try {
    const address = await fastify.listen({ port: PORT, host: HOST });
    console.log(`\n  StreamSync relay running at: ${address}`);
    console.log(`  Web app available at:       http://localhost:${PORT}`);
    console.log(`  WebSocket endpoint:          ws://localhost:${PORT}/ws\n`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

bootstrap();
