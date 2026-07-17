const fs = require('fs');
const path = require('path');
const { resolveMoviePath } = require('./movies');
const {
  getOrCreateSession,
  restartSessionAt,
  closeSession,
  HLS_SEGMENT_SECONDS,
} = require('../lib/hlsSessionManager');

const WAIT_TIMEOUT_MS = 15000;
const WAIT_POLL_MS = 200;

// Quantos segmentos "à frente" do que já existe ainda contam como buffering
// normal (o ffmpeg simplesmente não chegou lá ainda) em vez de um seek de
// verdade. Curto o suficiente pra não confundir os dois casos.
const SEEK_THRESHOLD_SEGMENTS = 3;

function parseTrackParams(query) {
  return {
    audioTrack: Number(query.audio ?? 0) || 0,
    subTrack: query.sub !== undefined && query.sub !== '' ? Number(query.sub) : null,
  };
}

function sendError(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg);
}

function waitForFile(filePath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fs.existsSync(filePath)) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout esperando o ffmpeg gerar o arquivo'));
      setTimeout(check, WAIT_POLL_MS);
    };
    check();
  });
}

function highestGeneratedSegmentIndex(dir) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return -1;
  }
  let highest = -1;
  for (const name of files) {
    const match = name.match(/^segment_(\d+)\.ts$/);
    if (match) highest = Math.max(highest, parseInt(match[1], 10));
  }
  return highest;
}

// GET /hls/manifest?arquivo=<relPath>&audio=0&sub=
function handleHlsManifest(req, res, query) {
  const filePath = resolveMoviePath(query.arquivo);
  if (!filePath) return sendError(res, 404, 'Arquivo não encontrado ou caminho inválido.');

  const { audioTrack, subTrack } = parseTrackParams(query);
  const session = getOrCreateSession(filePath, { audioTrack, subTrack });
  const manifestPath = path.join(session.dir, 'index.m3u8');

  waitForFile(manifestPath, WAIT_TIMEOUT_MS)
    .then(() => {
      // O ffmpeg escreve linhas tipo "segment_00000.ts" no .m3u8. Isso não
      // dá pra servir cru: precisamos que cada linha vire uma URL pra
      // /hls/segment com os mesmos query params (arquivo/audio/sub), senão
      // o hls.js ia tentar resolver um caminho relativo que não existe
      // nesse formato de rota.
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const rewritten = raw.replace(/^segment_\d{5}\.ts$/gm, (nome) => {
        const params = new URLSearchParams({ arquivo: query.arquivo, audio: String(audioTrack), nome });
        if (subTrack !== null) params.set('sub', String(subTrack));
        return `segment?${params.toString()}`;
      });

      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache',
      });
      res.end(rewritten);
    })
    .catch(() => sendError(res, 504, 'O ffmpeg demorou demais pra iniciar. Verifique se está instalado e no PATH.'));
}

// GET /hls/segment?arquivo=<relPath>&audio=0&sub=&nome=segment_00003.ts
function handleHlsSegment(req, res, query) {
  const filePath = resolveMoviePath(query.arquivo);
  if (!filePath) return sendError(res, 404, 'Arquivo não encontrado ou caminho inválido.');

  const segmentName = query.nome;
  const match = /^segment_(\d{5})\.ts$/.exec(segmentName || '');
  if (!match) return sendError(res, 400, 'Nome de segmento inválido.');
  const requestedIndex = parseInt(match[1], 10);

  const { audioTrack, subTrack } = parseTrackParams(query);
  let session = getOrCreateSession(filePath, { audioTrack, subTrack });
  session.touch();

  let segmentPath = path.join(session.dir, segmentName);

  if (fs.existsSync(segmentPath)) {
    return streamSegment(res, segmentPath);
  }

  const highest = highestGeneratedSegmentIndex(session.dir);
  const isSeek = requestedIndex > highest + SEEK_THRESHOLD_SEGMENTS;

  if (isSeek) {
    const startSeconds = requestedIndex * HLS_SEGMENT_SECONDS;
    session = restartSessionAt(filePath, { audioTrack, subTrack }, startSeconds);
    segmentPath = path.join(session.dir, segmentName);
  }

  waitForFile(segmentPath, WAIT_TIMEOUT_MS)
    .then(() => streamSegment(res, segmentPath))
    .catch(() => sendError(res, 504, 'Segmento demorou demais pra ficar pronto.'));
}

function streamSegment(res, segmentPath) {
  res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-cache' });
  fs.createReadStream(segmentPath).pipe(res);
}

// Chamado via sendBeacon quando o player fecha (beforeunload) — derruba o
// ffmpeg e libera o cache imediatamente, em vez de esperar o reaper.
// GET/POST tanto faz aqui, sendBeacon manda POST sem corpo relevante.
function handleHlsClose(req, res, query) {
  const filePath = resolveMoviePath(query.arquivo);
  if (filePath) {
    const { audioTrack, subTrack } = parseTrackParams(query);
    closeSession(filePath, audioTrack, subTrack);
  }
  res.writeHead(204);
  res.end();
}

module.exports = { handleHlsManifest, handleHlsSegment, handleHlsClose };
