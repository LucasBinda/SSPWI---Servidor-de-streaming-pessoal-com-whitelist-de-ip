const http = require('http');
const os = require('os');

const checarWhitelist = require('./middleware/ipWhitelist');
const { handleAuthSession, checarSessao } = require('./middleware/sessionCookie');
const { logManager } = require('./lib/logManager');
const { loadSettings, validarAntiFilterLog } = require('./lib/settings');
const { handleMoviesApi, handleStream } = require('./routes/movies');
const { scanMoviesDir, sincronizarCatalogo } = require('./lib/catalog');
const { handleMediaTracks, handleMediaSubtitle, handleMediaAudio } = require('./routes/media');
const { handleWatchTimeGet, handleWatchTimeSave, handlePrefsGet, handlePrefsSave } = require('./routes/user');
const { podarOrfaos, migrar: migrarUsuarios } = require('./lib/userStore');
const { prepararWorker, enfileirarNaoMp4 } = require('./lib/reencodeWorker');
const { iniciarAtualizadorDuckdns } = require('./lib/duckdns');
const { coverPicker } = require('./lib/coverPicker');
const { serveStatic } = require('./lib/staticServer');

const { PUBLIC_DIR, COVERS_DIR, MOVIES_DIR } = require('./lib/paths');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // Rede de segurança do processo: qualquer exceção SÍNCRONA num handler
  // (ex.: um Range malformado que escapasse da validação, um bug novo)
  // derrubaria o servidor inteiro sem isto — um único cliente tirava todo
  // mundo do ar. Aqui vira um 500 e o servidor segue de pé. Erros de stream
  // JÁ iniciado não caem aqui (rodam noutro tick) — são tratados no 'error'
  // do próprio stream (lib/httpRange.js).
  try {
    manejarRequisicao(req, res);
  } catch (err) {
    logManager.registrarErro('servidor', `erro não tratado em ${req.method} ${req.url}: ${(err && err.message) || err}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Erro interno do servidor.');
    } else {
      res.destroy();
    }
  }
});

function manejarRequisicao(req, res) {
  // Camada de acesso: se o IP não estiver autorizado, checarWhitelist já
  // escreve a resposta 403 sozinha e retorna false — a requisição para aqui.
  if (!checarWhitelist(req, res)) {
    return;
  }

  // Conexão autorizada -> "Horario - ip" em logs/conexoes.log. Usa o MESMO
  // getClientIp da whitelist (respeita proxies confiáveis), e o LogManager
  // deduplica por IP numa janela de 30min — sem isso, cada carregamento de
  // página viraria meia dúzia de linhas idênticas. O IP fica guardado pra
  // ser reaproveitado pelo log de chamadas nas rotas de conteúdo abaixo.
  const clientIp = checarWhitelist.getClientIp(req, loadSettings().proxiesConfiaveis);
  logManager.registrarConexao(clientIp);

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

  // Gravações via navigator.sendBeacon são SEMPRE POST — checadas ANTES da
  // restrição geral GET/HEAD abaixo. Aceitar GET numa rota com efeito
  // colateral a deixaria acessível por URL simples (uma <img src> maliciosa a
  // dispararia); SameSite=Strict já barra isso, mas POST-only é a trava certa.
  if (pathname === '/watchtime/save' || pathname === '/user/prefs/save') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Método não suportado.');
    }
    const query = Object.fromEntries(parsedUrl.searchParams);
    return pathname === '/watchtime/save'
      ? handleWatchTimeSave(req, res, query)
      : handlePrefsSave(req, res, query);
  }

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
    // "Horario - ip - chamada" em logs/chamadas.log (deduplicado por
    // IP+chamada no LogManager — mesmo esquema pro filme e legenda abaixo).
    logManager.registrarChamada(clientIp, 'catálogo');
    return handleMoviesApi(req, res);
  }

  // Streaming de vídeo (com suporte a range requests). searchParams já vem
  // decodificado pela própria API URL — sem decode manual aqui também.
  if (pathname === '/stream') {
    const query = Object.fromEntries(parsedUrl.searchParams);
    if (query.arquivo) logManager.registrarChamada(clientIp, `filme: ${query.arquivo}`);
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
    if (query.arquivo) logManager.registrarChamada(clientIp, `legenda: ${query.arquivo}`);
    return handleMediaSubtitle(req, res, query);
  }
  if (pathname === '/media/audio') {
    const query = Object.fromEntries(parsedUrl.searchParams);
    if (query.arquivo) logManager.registrarChamada(clientIp, `faixa de áudio: ${query.arquivo}`);
    return handleMediaAudio(req, res, query);
  }

  // Dados por usuário (uid do cookie): resume por filme e preferências que
  // seguem o login (volume, idioma de áudio). Ver lib/userStore.js.
  if (pathname === '/watchtime/get') {
    const query = Object.fromEntries(parsedUrl.searchParams);
    return handleWatchTimeGet(req, res, query);
  }
  if (pathname === '/user/prefs') {
    return handlePrefsGet(req, res);
  }

  // Capas dos filmes
  if (pathname.startsWith('/covers/')) {
    const relPath = pathname.replace('/covers/', '');
    return serveStatic(COVERS_DIR, relPath, res);
  }

  // Frontend estático (catálogo, player, css, js) — "/" vira index.html
  const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  return serveStatic(PUBLIC_DIR, relPath, res);
}

server.listen(PORT, () => {
  // Validação do antiFilterLog: só true/false explícitos valem; ausente ou
  // inválido cai no padrão false (dedupe ligado). O runtime já é seguro
  // (deveRegistrar compara === true) — este aviso é só pra você saber.
  const afl = validarAntiFilterLog();
  if (afl.valido) {
    logManager.info('config', `antiFilterLog: ${afl.valor} — ${afl.valor ? 'dedupe de logs DESLIGADO (todo bloqueio/chamada/conexão registrado)' : 'dedupe de logs ativo'}`);
  } else {
    logManager.aviso('config', 'antiFilterLog ausente ou inválido em config/settings.json (esperado true/false) — usando padrão false, dedupe de logs ativo');
  }
  console.log('Lembre de abrir a porta no firewall/roteador para acesso remoto');
  console.log(`Servidor de streaming rodando na porta ${PORT}`);
  console.log(`Acesse via http://<ip-do-servidor>:${PORT}`);
  
  // Endereços reais desta máquina, um por família, pra copiar e colar
  // direto no navegador. Link-local IPv6 (fe80::) fica de fora: não é
  // acessível de outra rede e exigiria zone-id na URL. IPv6 vai entre
  // colchetes — é a sintaxe obrigatória de URL pra essa família.
  const interfaces = Object.values(os.networkInterfaces()).flat();
  const ipv4 = interfaces.find((i) => i && !i.internal && i.family === 'IPv4');
  const ipv6 = interfaces.find((i) => i && !i.internal && i.family === 'IPv6' && !i.address.startsWith('fe80'));
  if (ipv4) console.log(`IPv4: http://${ipv4.address}:${PORT}`);
  if (ipv6) console.log(`IPv6: http://[${ipv6.address}]:${PORT}`);


  // Migração única (idempotente): converte o data/watchtime.json antigo pro
  // novo data/users.json (watch time + prefs por usuário). Roda no boot,
  // antes de servir; não faz nada se users.json já existe.
  migrarUsuarios();

  // limpa temporários de conversões interrompidas e enfileira
  // qualquer não-mp4 já presente no acervo (vídeos adicionados enquanto o
  // servidor estava desligado). Novos arquivos detectados em runtime são
  // enfileirados pelo /api/movies (routes/movies.js).
  prepararWorker();
  const arquivos = scanMoviesDir(MOVIES_DIR);
  enfileirarNaoMp4(arquivos);

  // sincroniza o catálogo já no boot (sem esperar a primeira
  // visita) e gera capa pra quem não tem — ou pra quem referencia uma capa
  // local que não existe mais em disco.
  coverPicker.garantirCapas(sincronizarCatalogo(arquivos));

  // Higiene de dados atrelados a cookies mortos, INDEPENDENTE de tráfego:
  // minutagem de logins expirados (data/watchtime.json) e entradas
  // automáticas vencidas da whitelist. Roda no boot e a cada 6h — garante
  // que cookie deletado/expirado leva os dados dele junto mesmo que
  // ninguém mais use o servidor pra disparar as podas de gravação.
  const limparDadosDeSessoesMortas = () => {
    podarOrfaos();
    checarWhitelist.podarAutoIpsExpirados();
  };
  limparDadosDeSessoesMortas();
  setInterval(limparDadosDeSessoesMortas, 6 * 60 * 60 * 1000).unref();

  // DNS dinâmico: com domínio+token do DuckDNS no config/settings.json, o
  // servidor mantém o domínio apontando pro IP da casa — pré-requisito do
  // HTTPS via proxy reverso (docs/https-duckdns.md). Sem configurar,
  // fica dormente.
  iniciarAtualizadorDuckdns();
});
