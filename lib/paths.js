const path = require('path');

// Caminhos do projeto num lugar só. Antes, MOVIES_DIR / COVERS_DIR /
// CATALOG_PATH eram redefinidos em 3 módulos cada (routes/movies,
// reencodeWorker, coverPicker...) — um typo num deles descolava silenciosamente
// os módulos (um gravando num caminho, outro lendo de outro). Aqui é a fonte
// única: todo módulo importa daqui.
//
// RAIZ é a pasta do projeto (este arquivo mora em lib/, então sobe um nível).
const RAIZ = path.join(__dirname, '..');

module.exports = {
  RAIZ,

  // Front-end estático e mídia
  PUBLIC_DIR: path.join(RAIZ, 'public'),
  MOVIES_DIR: path.join(RAIZ, 'media', 'movies'),
  COVERS_DIR: path.join(RAIZ, 'media', 'covers'),

  // "Bancos de dados" JSON (data/, gitignorado)
  DATA_DIR: path.join(RAIZ, 'data'),
  CATALOG_PATH: path.join(RAIZ, 'data', 'catalog.json'),
  // users.json: dados por usuário (uid do cookie) — watch time + preferências.
  // watchtime.json é o formato ANTIGO (só watch time), mantido só como origem
  // da migração única em lib/userStore.js.
  USERS_PATH: path.join(RAIZ, 'data', 'users.json'),
  WATCHTIME_PATH: path.join(RAIZ, 'data', 'watchtime.json'),
  REENCODE_STATE_PATH: path.join(RAIZ, 'data', 'reencode-state.json'),
  SESSION_SECRET_PATH: path.join(RAIZ, 'data', 'session-secret'),

  // Configuração (config/)
  WHITELIST_PATH: path.join(RAIZ, 'config', 'whitelist.json'),
  SETTINGS_PATH: path.join(RAIZ, 'config', 'settings.json'),

  // Caches gerados (cache/, gitignorado)
  CACHE_DIR: path.join(RAIZ, 'cache'),
  REENCODE_WORK_DIR: path.join(RAIZ, 'cache', 'reencode'),
  SUBS_CACHE_ROOT: path.join(RAIZ, 'cache', 'subs'),

  // Logs (logs/, gitignorado)
  LOGS_DIR: path.join(RAIZ, 'logs'),
};
