const { getClientIp } = require('./ipWhitelist');
const { loadSettings } = require('../lib/settings');
const { logManager } = require('../lib/logManager');
const {
  emitirToken,
  sessaoDaRequisicao,
  NOME_COOKIE,
  RENOVAR_EM_SEGUNDOS,
} = require('../lib/sessionToken');

// Camada de sessão (login persistente) POR CIMA da whitelist de IP.
// Toda função aqui assume que checarWhitelist já passou — seja pela lista
// manual, pela automática, ou pelo próprio cookie (ver ipWhitelist.js).

// GET /auth/session — cria ou renova o login.
//
// Com cookie válido: renova PRESERVANDO uid e criadoEm — a expiração
// desliza mais DURACAO_SESSAO_DIAS pra frente (limitada ao teto de
// VIDA_MAXIMA_DIAS do primeiro login). Como o front chama isso
// periodicamente enquanto o site está aberto, "usuário usando o site" =
// sessão sempre renovada.
//
// Sem cookie (ou expirado/adulterado): emite um login NOVO, com uid novo.
// Só se chega aqui sem cookie válido estando num IP autorizado — ou seja,
// login novo continua exigindo passar pela whitelist manual primeiro.
function handleAuthSession(req, res) {
  const sessaoAtual = sessaoDaRequisicao(req);
  const { token, exp } = emitirToken(sessaoAtual.valido ? sessaoAtual.dados : null);

  const maxAgeSegundos = Math.max(1, Math.floor((exp - Date.now()) / 1000));

  // Secure só quando o acesso passa por um proxy HTTPS (Caddy/nginx, ver
  // docs/https-duckdns.md): com a flag, o navegador só envia o cookie
  // criptografado — em HTTP puro na LAN ela precisa ficar DESLIGADA, senão o
  // cookie nunca chega e o login quebra. Por isso é opt-in via settings.
  const flagSecure = loadSettings().atrasDeProxyTls ? '; Secure' : '';

  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    // HttpOnly: JS da página não lê o cookie (XSS não rouba sessão).
    // SameSite=Strict: outros sites não conseguem disparar requisições
    // autenticadas.
    'Set-Cookie': `${NOME_COOKIE}=${token}; Max-Age=${maxAgeSegundos}; Path=/; HttpOnly; SameSite=Strict${flagSecure}`,
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({
    ok: true,
    renovado: sessaoAtual.valido,
    expiraEmSegundos: maxAgeSegundos,
    renovarEmSegundos: RENOVAR_EM_SEGUNDOS,
  }));
}

// Retorna true se a sessão vale. Se não vale, já respondeu 401 (JSON) e
// logou o motivo — mesmo contrato do checarWhitelist: quem chamou só para.
function checarSessao(req, res) {
  const resultado = sessaoDaRequisicao(req);
  if (resultado.valido) return true;

  const settings = loadSettings();
  const ip = getClientIp(req, settings.proxiesConfiaveis);
  logManager.registrarBloqueio(ip, `sessão negada (${resultado.motivo}) -> ${req.method} ${req.url}`);
  res.writeHead(401, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ erro: 'sessao_invalida' }));
  return false;
}

module.exports = { handleAuthSession, checarSessao };
