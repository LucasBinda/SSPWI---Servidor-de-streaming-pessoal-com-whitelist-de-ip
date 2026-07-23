const fs = require('fs');
const { VIDA_MAXIMA_DIAS } = require('./sessionToken');
const { lerJson } = require('./jsonStore');
const { USERS_PATH, WATCHTIME_PATH } = require('./paths');
const { logManager } = require('./logManager');
const { RetentionStore } = require('./stores');

// Persistência POR USUÁRIO (o "User" do projeto), em data/users.json — o
// mesmo padrão de "banco JSON" do catalog.json/reencode-state.json, agora
// como uma subclasse de RetentionStore (lib/stores.js): a poda por tempo e a
// participação na varredura global vêm da superclasse; aqui só mora o que é
// específico do formato de usuário.
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

class UserStore extends RetentionStore {
  constructor() {
    super('user', USERS_PATH, {
      padrao: {},
      validar: (d) => d && typeof d === 'object' && !Array.isArray(d),
      janelaMs: RETENCAO_MS,
    });
  }

  // Poda (o gancho que a superclasse chama na varredura): remove o usuário
  // INTEIRO se o login morreu (sem atividade além da retenção) — leva watch
  // time E preferências junto. Em usuário vivo, ainda poda filmes individuais
  // antigos, pra limitar o tamanho de quem assiste muita coisa dentro da vida
  // do login.
  podar(dados) {
    for (const [uid, u] of Object.entries(dados)) {
      if (!u || !this.vivoEm(u.atualizadoEm)) {
        delete dados[uid];
        continue;
      }
      for (const [arquivo, registro] of Object.entries(u.watchtime || {})) {
        if (!registro || !this.vivoEm(registro.atualizadoEm)) {
          delete u.watchtime[arquivo];
        }
      }
    }
  }

  // Garante o "esqueleto" de um usuário no objeto carregado.
  _garantirUsuario(dados, uid) {
    const u = dados[uid] || (dados[uid] = {});
    if (!u.watchtime || typeof u.watchtime !== 'object') u.watchtime = {};
    if (!u.prefs || typeof u.prefs !== 'object') u.prefs = {};
    return u;
  }

  // --- Watch time ---------------------------------------------------------

  // Gravação leve: read-modify-write síncrono (o single-thread do Node garante
  // atomicidade dentro do tick) num arquivo pequeno — mais simples e robusto
  // que estado em memória com flush (nada se perde num crash).
  salvarTempo(uid, arquivo, segundos) {
    const dados = this.carregar();
    this.podar(dados);
    const u = this._garantirUsuario(dados, uid);
    u.watchtime[arquivo] = { segundos: Math.max(0, Math.floor(segundos)), atualizadoEm: Date.now() };
    u.atualizadoEm = Date.now();
    try {
      this.salvar(dados);
    } catch (err) {
      logManager.registrarErro('user', `falha ao salvar tempo: ${err.message}`);
    }
  }

  obterTempo(uid, arquivo) {
    const u = this.carregar()[uid];
    if (!u || !this.vivoEm(u.atualizadoEm)) return 0;
    const registro = u.watchtime && u.watchtime[arquivo];
    if (!registro || !this.vivoEm(registro.atualizadoEm)) return 0;
    return registro.segundos;
  }

  // Quando o worker de re-encode renomeia um arquivo (.mkv -> .mp4), o resume
  // de TODOS os usuários naquele filme acompanha o nome novo.
  renomearArquivo(relAntigo, relNovo) {
    const dados = this.carregar();
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
        this.salvar(dados);
      } catch (err) {
        logManager.registrarErro('user', `falha ao renomear registros: ${err.message}`);
      }
    }
  }

  // --- Preferências que seguem o usuário ----------------------------------

  // Devolve as prefs do usuário (ou {} se login morto/inexistente).
  obterPrefs(uid) {
    const u = this.carregar()[uid];
    if (!u || !this.vivoEm(u.atualizadoEm)) return {};
    return u.prefs || {};
  }

  // Merge parcial: salva só as chaves informadas (o volume não apaga o
  // audioIdioma e vice-versa). O chamador (routes/user.js) já validou os valores.
  salvarPrefs(uid, parciais) {
    const dados = this.carregar();
    this.podar(dados);
    const u = this._garantirUsuario(dados, uid);
    u.prefs = { ...u.prefs, ...parciais };
    u.atualizadoEm = Date.now();
    try {
      this.salvar(dados);
    } catch (err) {
      logManager.registrarErro('user', `falha ao salvar prefs: ${err.message}`);
    }
  }

  // --- Migração -----------------------------------------------------------

  // Migração única do formato antigo: se users.json ainda não existe mas o
  // watchtime.json antigo ({uid:{arquivo:{...}}}) existe, converte pro novo
  // formato ({uid:{watchtime,prefs,atualizadoEm}}) preservando o resume de
  // todo mundo. Chamada explicitamente no boot (server.js) — NÃO no require,
  // pra não disparar efeito no disco durante testes/carga. O watchtime.json é
  // deixado intacto como backup (o usuário apaga quando quiser).
  migrar() {
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
      this.salvar(novo);
      logManager.info('user', `migrado watchtime.json -> users.json (${Object.keys(novo).length} usuário(s))`);
    } catch (err) {
      logManager.registrarErro('user', `falha ao migrar watchtime.json: ${err.message}`);
    }
  }
}

// Instância única (o require já a registra na superclasse pra varredura). A
// API de funções é mantida pra não mexer em quem importa (routes/user.js,
// reencodeWorker.js, server.js, os testes).
const store = new UserStore();

module.exports = {
  salvarTempo: (uid, arquivo, segundos) => store.salvarTempo(uid, arquivo, segundos),
  obterTempo: (uid, arquivo) => store.obterTempo(uid, arquivo),
  renomearArquivo: (relAntigo, relNovo) => store.renomearArquivo(relAntigo, relNovo),
  obterPrefs: (uid) => store.obterPrefs(uid),
  salvarPrefs: (uid, parciais) => store.salvarPrefs(uid, parciais),
  migrar: () => store.migrar(),
  // Mantido pra compatibilidade (server.js hoje usa Store.podarTodas(), mas o
  // teste e qualquer chamador antigo continuam funcionando): poda + persiste.
  podarOrfaos: () => store.podarEPersistir(),
};
