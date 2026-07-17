const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_ROOT = path.join(__dirname, '..', 'cache', 'hls');
const HLS_SEGMENT_SECONDS = 6;
const SESSION_TTL_MS = 2 * 60 * 1000; // sem requisição há 2min -> sessão morta

/** @type {Map<string, Session>} */
const sessions = new Map();

class Session {
  constructor(sessionKey, videoPath, { audioTrack = 0, subTrack = null, startSeconds = 0 } = {}) {
    this.key = sessionKey;
    this.videoPath = videoPath;
    this.dir = path.join(CACHE_ROOT, sessionKey);
    this.audioTrack = audioTrack;
    this.subTrack = subTrack;
    this.startSeconds = startSeconds;
    this.lastAccess = Date.now();
    this.proc = null;
    this.ready = false;
    this.readyPromise = null;
  }

  start() {
    fs.mkdirSync(this.dir, { recursive: true });

    const args = [
      '-y',
      ...(this.startSeconds > 0 ? ['-ss', String(this.startSeconds)] : []),
      '-i', this.videoPath,
      '-map', '0:v:0',
      '-map', `0:a:${this.audioTrack}`,
      ...(this.subTrack !== null ? ['-map', `0:s:${this.subTrack}`, '-c:s', 'webvtt'] : []),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-ac', '2',
      '-f', 'hls',
      '-hls_time', String(HLS_SEGMENT_SECONDS),
      '-hls_list_size', '0',
      '-hls_flags', 'independent_segments',
      '-hls_segment_filename', path.join(this.dir, 'segment_%05d.ts'),
      '-start_number', String(Math.floor(this.startSeconds / HLS_SEGMENT_SECONDS)),
      path.join(this.dir, 'index.m3u8'),
    ];

    console.log(`[hls] iniciando sessão ${this.key} (${path.basename(this.videoPath)}, start=${this.startSeconds}s)`);
    this.proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    this.proc.stderr.on('data', (chunk) => {
      const msg = chunk.toString();
      if (/error|invalid|no such file/i.test(msg)) console.error(`[hls ${this.key}]`, msg.trim());
    });

    this.proc.on('error', (err) => {
      console.error(`[hls ${this.key}] falha ao iniciar ffmpeg (está instalado e no PATH?):`, err.message);
    });

    this.proc.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) console.error(`[hls ${this.key}] ffmpeg saiu com código ${code}`);
      if (signal) console.log(`[hls ${this.key}] ffmpeg encerrado (${signal})`);
    });
  }

  touch() {
    this.lastAccess = Date.now();
  }

  destroy() {
    if (this.proc && this.proc.exitCode === null) this.proc.kill('SIGTERM');
    sessions.delete(this.key);
    fs.rm(this.dir, { recursive: true, force: true }, (err) => {
      if (err) console.error(`[hls ${this.key}] falha ao limpar cache:`, err.message);
    });
  }
}

function makeSessionKey(videoPath, audioTrack, subTrack) {
  return crypto.createHash('sha1').update(`${videoPath}:${audioTrack}:${subTrack}`).digest('hex').slice(0, 20);
}

// Devolve a sessão existente (se houver) ou cria uma nova do zero (start=0).
function getOrCreateSession(videoPath, { audioTrack = 0, subTrack = null } = {}) {
  const key = makeSessionKey(videoPath, audioTrack, subTrack);
  const existing = sessions.get(key);
  if (existing) {
    existing.touch();
    return existing;
  }

  const session = new Session(key, videoPath, { audioTrack, subTrack });
  sessions.set(key, session);
  session.start();
  return session;
}

// Chamado quando o player pede um segmento que está muito à frente do que
// já foi gerado -> é um seek. Mata a sessão antiga (libera o cache dela
// imediatamente, já que temos pouco disco) e começa uma nova a partir do
// ponto pedido.
function restartSessionAt(videoPath, { audioTrack = 0, subTrack = null } = {}, startSeconds) {
  const key = makeSessionKey(videoPath, audioTrack, subTrack);
  const existing = sessions.get(key);
  if (existing) existing.destroy();

  const session = new Session(key, videoPath, { audioTrack, subTrack, startSeconds });
  sessions.set(key, session);
  session.start();
  return session;
}

function closeSession(videoPath, audioTrack = 0, subTrack = null) {
  const key = makeSessionKey(videoPath, audioTrack, subTrack);
  const session = sessions.get(key);
  if (session) session.destroy();
}

function startReaper() {
  setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (now - session.lastAccess > SESSION_TTL_MS) {
        console.log(`[hls] sessão ${session.key} inativa há mais de 2min, encerrando`);
        session.destroy();
      }
    }
  }, 30 * 1000).unref();
}

module.exports = {
  getOrCreateSession,
  restartSessionAt,
  closeSession,
  startReaper,
  HLS_SEGMENT_SECONDS,
  CACHE_ROOT,
};
