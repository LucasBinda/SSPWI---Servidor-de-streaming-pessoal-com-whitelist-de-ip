const http = require('http');
const url = require('url');
const path = require('path');

const checarWhitelist = require('./middleware/ipWhitelist');
const { handleMoviesApi, handleStream } = require('./routes/movies');
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

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Método não suportado.');
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  // API do catálogo
  if (pathname === '/api/movies') {
    return handleMoviesApi(req, res);
  }

  // Streaming de vídeo (com suporte a range requests)
  if (pathname === '/stream') {
    return handleStream(req, res, parsedUrl.query);
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
});
