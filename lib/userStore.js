const fs = require('fs');
const { VIDA_MAXIMA_DIAS } = require('./sessionToken');
const { lerJson, salvarJson } = require('./jsonStore');
const { USERS_PATH, WATCHTIME_PATH } = require('./paths');
const { logManager } = require('./logManager');

// Persistência POR USUÁRIO (o "User" do projeto), em data/users.json — o
// mesmo padrão de "banco JSON" do catalog.json/reencode-state.json.
//
// Estrutura:
//   { [uid]: {
//       watchtime: { [arquivoRel]: { segundos, atualizadoEm } },  // resume por filme
//       prefs:     { volume, audioIdioma },                       // seguem o usuário
//       atualizadoEm                                              // última atividade do uid
//   } }
//
// O uid é o do cookie de login persistente (lib/sessionToken.js): é ele que
// faz os dados sobreviverem a troca de IP/aba/dispositivo enquanto o login
// viver. Nenhum login passa de VIDA_MAXIMA_DIAS, então uid sem atividade há
// mais que isso é login morto — podado automaticamente (o arquivo não cresce
// pra sempre). Isso vale pro conjunto INTEIRO do usuário: preferências também
// resetam junto com o login (decisão consciente — ver docs).
//
// O que é per-DISPOSITIVO (equalizador, stats, ajuste de imagem) NÃO mora
// aqui: fica no localStorage do navegador, de propósito (ver player/*.js).
// Aqui só o que deve SEGUIR o usuário: onde parou cada filme, o volume e o
// idioma de áudio preferido.

const RETENCAO_MS = VIDA_MAXIMA_DIAS * 24 * 60 * 60 * 1000;

function carregar() {
  return lerJson(USERS_PATH, {}, (d) => d && typeof d === 'object' && !Array.isArray(d));
}

function salvar(dados) {
  salvarJson(USERS_PATH, dados);
}

// Garante o "esqueleto" de um usuário no objeto carregado.
function garantirUsuario(dados, uid) {
  const u = dados[uid] || (dados[uid] = {});
  if (!u.watchtime || typeof u.watchtime !== 'object') u.watchtime = {};
  if (!u.prefs || typeof u.prefs !== 'object') u.prefs = {};
  return u;
}

// Poda: remove o usuário INTEIRO se o login morreu (sem atividade há mais que
// a retenção) — leva watch time E preferências junto. Em usuário vivo, ainda
// poda filmes individuais antigos, pra limitar o tamanho de quem assiste
// muita coisa dentro da vida do login.
function podar(dados) {
  const limite = Date.now() - RETENCAO_MS;
  for (const [uid, u] of Object.entries(dados)) {
    if (!u || typeof u.atualizadoEm !== 'number' || u.atualizadoEm < limite) {
      delete dados[uid];
      continue;
    }
    for (const [arquivo, registro] of Object.entries(u.watchtime || {})) {
      if (!registro || typeof registro.atualizadoEm !== 'number' || registro.atualizadoEm < limite) {
        delete u.watchtime[arquivo];
      }
    }
  }
}

// Um usuário está "vivo" (login não expirado)? Blinda a leitura por conta
// própria, mesmo que a varredura de limpeza ainda não tenha passado.
function vivo(u) {
  return u && typeof u.atualizadoEm === 'number' && u.atualizadoEm >= Date.now() - RETENCAO_MS;
}

// --- Watch time -----------------------------------------------------------

// Gravação leve: read-modify-write síncrono (o single-thread do Node garante
// atomicidade dentro do tick) num arquivo pequeno — mais simples e robusto
// que estado em memória com flush (nada se perde num crash).
function salvarTempo(uid, arquivo, segundos) {
  const dados = carregar();
  podar(dados);
  const u = garantirUsuario(dados, uid);
  u.watchtime[arquivo] = { segundos: Math.max(0, Math.floor(segundos)), atualizadoEm: Date.now() };
  u.atualizadoEm = Date.now();
  try {
    salvar(dados);
  } catch (err) {
    logManager.registrarErro('user', `falha ao salvar tempo: ${err.message}`);
  }
}

function obterTempo(uid, arquivo) {
  const u = carregar()[uid];
  if (!vivo(u)) return 0;
  const registro = u.watchtime && u.watchtime[arquivo];
  if (!registro || typeof registro.atualizadoEm !== 'number' || registro.atualizadoEm < Date.now() - RETENCAO_MS) {
    return 0;
  }
  return registro.segundos;
}

// Quando o worker de re-encode renomeia um arquivo (.mkv -> .mp4), o resume
// de TODOS os usuários naquele filme acompanha o nome novo.
function renomearArquivo(relAntigo, relNovo) {
  const dados = carregar();
  let mudou = false;
  for (const u of Object.values(dados)) {
    if (u && u.watchtime && u.watchtime[relAntigo]) {
      u.watchtime[relNovo] = u.watchtime[relAntigo];
      delete u.watchtime[relAntigo];
      mudou = true;
    }
  }
  if (mudou) {
    try {
      salvar(dados);
    } catch (err) {
      logManager.registrarErro('user', `falha ao renomear registros: ${err.message}`);
    }
  }
}

// --- Preferências que seguem o usuário ------------------------------------

// Devolve as prefs do usuário (ou {} se login morto/inexistente).
function obterPrefs(uid) {
  const u = carregar()[uid];
  if (!vivo(u)) return {};
  return u.prefs || {};
}

// Merge parcial: salva só as chaves informadas (o volume não apaga o
// audioIdioma e vice-versa). O chamador (routes/user.js) já validou os valores.
function salvarPrefs(uid, parciais) {
  const dados = carregar();
  podar(dados);
  const u = garantirUsuario(dados, uid);
  u.prefs = { ...u.prefs, ...parciais };
  u.atualizadoEm = Date.now();
  try {
    salvar(dados);
  } catch (err) {
    logManager.registrarErro('user', `falha ao salvar prefs: ${err.message}`);
  }
}

// --- Limpeza e migração ---------------------------------------------------

// Varredura de limpeza (server.js: boot + a cada 6h), INDEPENDENTE de
// tráfego: cookie morto => dados somem em no máximo RETENCAO_MS + o intervalo.
function podarOrfaos() {
  const dados = carregar();
  const antes = JSON.stringify(dados);
  podar(dados);
  if (JSON.stringify(dados) === antes) return;
  try {
    salvar(dados);
    logManager.info('user', 'dados de logins expirados removidos');
  } catch (err) {
    logManager.registrarErro('user', `falha ao podar órfãos: ${err.message}`);
  }
}

// Migração única do formato antigo: se users.json ainda não existe mas o
// watchtime.json antigo ({uid:{arquivo:{...}}}) existe, converte pro novo
// formato ({uid:{watchtime,prefs,atualizadoEm}}) preservando o resume de
// todo mundo. Chamada explicitamente no boot (server.js) — NÃO no require,
// pra não disparar efeito no disco durante testes/carga. O watchtime.json é
// deixado intacto como backup (o usuário apaga quando quiser).
function migrar() {
  if (fs.existsSync(USERS_PATH)) return;
  const antigo = lerJson(WATCHTIME_PATH, null, (d) => d && typeof d === 'object' && !Array.isArray(d));
  if (!antigo || Object.keys(antigo).length === 0) return;

  const novo = {};
  for (const [uid, filmes] of Object.entries(antigo)) {
    if (!filmes || typeof filmes !== 'object') continue;
    let maisRecente = 0;
    for (const reg of Object.values(filmes)) {
      if (reg && typeof reg.atualizadoEm === 'number' && reg.atualizadoEm > maisRecente) maisRecente = reg.atualizadoEm;
    }
    novo[uid] = { watchtime: filmes, prefs: {}, atualizadoEm: maisRecente || Date.now() };
  }
  try {
    salvar(novo);
    logManager.info('user', `migrado watchtime.json -> users.json (${Object.keys(novo).length} usuário(s))`);
  } catch (err) {
    logManager.registrarErro('user', `falha ao migrar watchtime.json: ${err.message}`);
  }
}

module.exports = {
  salvarTempo,
  obterTempo,
  renomearArquivo,
  podarOrfaos,
  obterPrefs,
  salvarPrefs,
  migrar,
};
