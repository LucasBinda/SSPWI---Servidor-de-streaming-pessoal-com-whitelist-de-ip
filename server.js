const http = require('http');
const path = require('path');

const checarWhitelist = require('./middleware/ipWhitelist');
const { handleMoviesApi, handleStream } = require('./routes/movies');
const { handleHlsManifest, handleHlsSegment, handleHlsClose } = require('./routes/hls');
const { startReaper } = require('./lib/hlsSessionManager');
const { serveStatic } = require('./lib/staticServer');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const COVERS_DIR = path.join(__dirname, 'media', 'covers');

const server = http.createServer((req, res) => {
  // Camada de acesso: se o IP não estiver autorizado, checarWhitelist já
  // escreve a resposta 403 sozinha e retorna false — a requisição para aqui.
  if (!checarWhitelist(req, res)) {
    return;
  }

  // API WHATWG URL (new URL / URLSearchParams) no lugar do antigo
  // url.parse(): o próprio Node.js avisa (DEP0169) que url.parse() tem
  // comportamento inconsistente com implicações de segurança e não recebe
  // mais correção nem pra CVEs novos. URL é global — não precisa de require.
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('URL inválida.');
  }

  // pathname fica sem decodificar aqui de propósito: quem decodifica (uma
  // única vez) é o serveStatic, na hora de resolver o arquivo real — assim
  // evita decodificar duas vezes o mesmo caminho.
  const pathname = parsedUrl.pathname;

  // /hls/close precisa aceitar POST (o player avisa via navigator.sendBeacon
  // no beforeunload, que sempre manda POST) — por isso essa rota é checada
  // ANTES da restrição geral de método GET/HEAD que vem logo abaixo.
  if (pathname === '/hls/close') {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Método não suportado.');
    }
    const query = Object.fromEntries(parsedUrl.searchParams);
    return handleHlsClose(req, res, query);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Método não suportado.');
  }

  // API do catálogo
  if (pathname === '/api/movies') {
    return handleMoviesApi(req, res);
  }

  // Streaming de vídeo (com suporte a range requests). searchParams já vem
  // decodificado pela própria API URL — sem decode manual aqui também.
  if (pathname === '/stream') {
    const query = Object.fromEntries(parsedUrl.searchParams);
    return handleStream(req, res, query);
  }

  // HLS on-the-fly: manifesto (.m3u8) e segmentos (.ts) gerados sob demanda
  // pelo ffmpeg. Ver lib/hlsSessionManager.js pra lógica de sessão/seek.
  if (pathname === '/hls/manifest') {
    const query = Object.fromEntries(parsedUrl.searchParams);
    return handleHlsManifest(req, res, query);
  }
  if (pathname === '/hls/segment') {
    const query = Object.fromEntries(parsedUrl.searchParams);
    return handleHlsSegment(req, res, query);
  }

  // Capas dos filmes
  if (pathname.startsWith('/covers/')) {
    const relPath = pathname.replace('/covers/', '');
    return serveStatic(COVERS_DIR, relPath, res);
  }

  // Frontend estático (catálogo, player, css, js) — "/" vira index.html
  const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  return serveStatic(PUBLIC_DIR, relPath, res);
});

server.listen(PORT, () => {
  console.log(`Servidor de streaming rodando na porta ${PORT}`);
  console.log(`Acesse via http://<ip-do-servidor>:${PORT}`);
  startReaper();
});
