const http = require('http');
const path = require('path');

const checarWhitelist = require('./middleware/ipWhitelist');
const { handleAuthSession, checarSessao } = require('./middleware/sessionCookie');
const { handleMoviesApi, handleStream, scanMoviesDir, sincronizarCatalogo, MOVIES_DIR } = require('./routes/movies');
const { handleMediaTracks, handleMediaSubtitle } = require('./routes/media');
const { prepararWorker, enfileirarNaoMp4 } = require('./lib/reencodeWorker');
const { coverPicker } = require('./lib/coverPicker');
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

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Método não suportado.');
  }

  // Fase 3: emissão/renovação do cookie de sessão. Única rota de conteúdo
  // sem exigência de sessão prévia (é onde ela nasce) — mas a whitelist já
  // passou lá em cima, então IP de fora nunca ganha token.
  if (pathname === '/auth/session') {
    return handleAuthSession(req, res);
  }

  // Rotas de CONTEÚDO exigem sessão válida além da whitelist (token+cookie
  // vinculado ao IP, ver middleware/sessionCookie.js). O front-end estático
  // (html/css/js) fica só atrás da whitelist — a página precisa carregar
  // pra conseguir pedir a sessão em /auth/session.
  const rotaProtegida =
    pathname === '/api/movies' ||
    pathname === '/stream' ||
    pathname.startsWith('/media/') ||
    pathname.startsWith('/covers/');
  if (rotaProtegida && !checarSessao(req, res)) {
    return;
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

  // Faixas de áudio/legenda disponíveis (menu de configurações do player)
  // e extração de legenda em WebVTT sob demanda. Operações leves de ffprobe/
  // ffmpeg — a transcodificação de vídeo em tempo real (HLS) foi removida
  // por pesar demais na CPU do servidor.
  if (pathname === '/media/tracks') {
    const query = Object.fromEntries(parsedUrl.searchParams);
    return handleMediaTracks(req, res, query);
  }
  if (pathname === '/media/subtitle') {
    const query = Object.fromEntries(parsedUrl.searchParams);
    return handleMediaSubtitle(req, res, query);
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

  // Fase 2: limpa temporários de conversões interrompidas e enfileira
  // qualquer não-mp4 já presente no acervo (vídeos adicionados enquanto o
  // servidor estava desligado). Novos arquivos detectados em runtime são
  // enfileirados pelo /api/movies (routes/movies.js).
  prepararWorker();
  const arquivos = scanMoviesDir(MOVIES_DIR);
  enfileirarNaoMp4(arquivos);

  // Fase 4: sincroniza o catálogo já no boot (sem esperar a primeira
  // visita) e gera capa pra quem não tem — ou pra quem referencia uma capa
  // local que não existe mais em disco.
  coverPicker.garantirCapas(sincronizarCatalogo(arquivos));
});
