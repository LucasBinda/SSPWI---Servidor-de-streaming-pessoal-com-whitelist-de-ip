const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Token de sessão assinado (HMAC-SHA256, só crypto nativo) — modelo de
// LOGIN PERSISTENTE entre sessões/IPs.
//
// O cookie não é mais vinculado ao IP: ele identifica o USUÁRIO (uid
// aleatório gerado no primeiro login). Se o IP da pessoa mudar, o cookie
// continua valendo — e, pela integração com a whitelist
// (middleware/ipWhitelist.js), o IP novo é adicionado automaticamente à
// lista temporária autoAllowedIps do whitelist.json. O uid também é o que
// vai ancorar o watch time por usuário (fase de persistência de tempo).
//
// Validade em dois níveis:
// - DESLIZANTE: cada renovação empurra a expiração pra frente em
//   DURACAO_SESSAO_DIAS (o front renova enquanto o site está em uso, então
//   usuário ativo nunca cai).
// - TETO ABSOLUTO: nenhuma renovação passa de VIDA_MAXIMA_DIAS contados do
//   PRIMEIRO login (criadoEm viaja preservado no payload). Depois disso o
//   login precisa renascer — o que exige estar num IP autorizado
//   manualmente, fechando a janela de um cookie roubado durar pra sempre.
//
// Formato: base64url(JSON{uid, criadoEm, exp}) + "." + HMAC do payload.
// Sem estado no servidor: nenhuma tabela de sessões — a assinatura prova
// que fomos nós que emitimos.

const { SESSION_SECRET_PATH: SECRET_PATH } = require('./paths');

// Duração deslizante de cada renovação. Ajuste aqui se quiser sessões mais
// curtas/longas — o resto do sistema (inclusive a expiração das entradas
// automáticas da whitelist) acompanha.
const DURACAO_SESSAO_DIAS = 2;
// Teto absoluto de vida de um login, contado do primeiro acesso — nenhuma
// quantidade de renovação passa daqui.
const VIDA_MAXIMA_DIAS = 7;

const DURACAO_SESSAO_MS = DURACAO_SESSAO_DIAS * 24 * 60 * 60 * 1000;
const VIDA_MAXIMA_MS = VIDA_MAXIMA_DIAS * 24 * 60 * 60 * 1000;

// Cadência de renovação do front-end ("usuário usando o site" = aba aberta
// pingando /auth/session nesse intervalo).
const RENOVAR_EM_SEGUNDOS = 10 * 60;

const NOME_COOKIE = 'sspwi_sessao';

// O segredo fica em cache em memória de propósito (diferente das configs,
// que são relidas a cada requisição): ele é DADO GERADO, não configuração
// editável — nunca muda depois de criado, e é usado em toda requisição
// protegida. Persistido em data/ (gitignorado) pra restart do servidor não
// derrubar as sessões de todo mundo.
let segredoCache = null;

function segredo() {
  if (segredoCache) return segredoCache;
  try {
    const lido = fs.readFileSync(SECRET_PATH, 'utf-8').trim();
    if (lido) {
      segredoCache = lido;
      return segredoCache;
    }
  } catch {
    /* primeiro boot — gera abaixo */
  }
  segredoCache = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
  fs.writeFileSync(SECRET_PATH, segredoCache + '\n', { mode: 0o600 });
  // require lazy: evita ciclo no carregamento (sessionToken é módulo base).
  require('./logManager').logManager.info('auth', 'segredo de sessão gerado em data/session-secret');
  return segredoCache;
}

function assinar(payload) {
  return crypto.createHmac('sha256', segredo()).update(payload).digest('base64url');
}

// Emite um token novo (login) ou renovado (login existente). Na renovação,
// uid e criadoEm são PRESERVADOS — é isso que mantém a identidade do
// usuário estável entre renovações e faz o teto de 7 dias valer de
// verdade (um exp deslizante sozinho nunca expiraria).
function emitirToken(sessaoExistente = null) {
  const agora = Date.now();
  const uid = sessaoExistente ? sessaoExistente.uid : crypto.randomBytes(12).toString('base64url');
  const criadoEm = sessaoExistente ? sessaoExistente.criadoEm : agora;
  const exp = Math.min(agora + DURACAO_SESSAO_MS, criadoEm + VIDA_MAXIMA_MS);

  const payload = Buffer.from(JSON.stringify({ uid, criadoEm, exp })).toString('base64url');
  return { token: `${payload}.${assinar(payload)}`, uid, exp };
}

// Devolve { valido, motivo, dados } — dados só quando válido. O motivo vai
// pro log de segurança, nunca pro cliente em detalhe.
function verificarToken(token) {
  if (!token) return { valido: false, motivo: 'sem cookie de sessão' };

  const partes = token.split('.');
  if (partes.length !== 2) return { valido: false, motivo: 'token malformado' };
  const [payload, assinatura] = partes;

  // timingSafeEqual exige buffers do mesmo tamanho — a checagem de length
  // antes não vaza nada útil (o tamanho da assinatura HMAC é público).
  const esperada = Buffer.from(assinar(payload));
  const recebida = Buffer.from(assinatura);
  if (recebida.length !== esperada.length || !crypto.timingSafeEqual(recebida, esperada)) {
    return { valido: false, motivo: 'assinatura inválida' };
  }

  let dados;
  try {
    dados = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch {
    return { valido: false, motivo: 'payload ilegível' };
  }

  const agora = Date.now();
  if (typeof dados.exp !== 'number' || agora > dados.exp) {
    return { valido: false, motivo: 'token expirado' };
  }
  if (typeof dados.criadoEm !== 'number' || agora > dados.criadoEm + VIDA_MAXIMA_MS) {
    return { valido: false, motivo: `login passou do teto de ${VIDA_MAXIMA_DIAS} dias` };
  }
  if (!dados.uid) {
    return { valido: false, motivo: 'token sem uid' };
  }

  return { valido: true, dados };
}

// Parser mínimo de Cookie (zero-dependência). Valores com "=" no meio
// (base64url do token tem) são preservados por causa do indexOf.
function parseCookies(header) {
  const cookies = {};
  for (const par of (header || '').split(';')) {
    const i = par.indexOf('=');
    if (i === -1) continue;
    cookies[par.slice(0, i).trim()] = par.slice(i + 1).trim();
  }
  return cookies;
}

// Atalho usado tanto pela camada de sessão quanto pela whitelist (que
// consulta a sessão pra decidir o auto-whitelist de IP): extrai e valida o
// token direto da requisição.
function sessaoDaRequisicao(req) {
  return verificarToken(parseCookies(req.headers.cookie)[NOME_COOKIE]);
}

module.exports = {
  emitirToken,
  verificarToken,
  sessaoDaRequisicao,
  NOME_COOKIE,
  DURACAO_SESSAO_DIAS,
  VIDA_MAXIMA_DIAS,
  RENOVAR_EM_SEGUNDOS,
};
