const { sessaoDaRequisicao } = require('../lib/sessionToken');
const { resolveMoviePath } = require('./movies');
const { salvarTempo, obterTempo, obterPrefs, salvarPrefs } = require('../lib/userStore');
const { sendError } = require('./util');

// Rotas de dados POR USUÁRIO (o uid vem do cookie de sessão). Todas assumem
// que a whitelist já passou; a sessão é validada aqui (precisamos do uid de
// qualquer forma). O que é do usuário: onde parou cada filme (watch time) e
// as preferências que seguem o login (volume, idioma de áudio).

// GET /watchtime/get?arquivo=<relPath> -> { segundos }
function handleWatchTimeGet(req, res, query) {
  const sessao = sessaoDaRequisicao(req);
  if (!sessao.valido) return sendError(res, 401, 'Sessão inválida.');
  if (!resolveMoviePath(query.arquivo)) return sendError(res, 404, 'Arquivo não encontrado.');

  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ segundos: obterTempo(sessao.dados.uid, query.arquivo) }));
}

// POST (sendBeacon) /watchtime/save?arquivo=<relPath>&t=<segundos>
function handleWatchTimeSave(req, res, query) {
  const sessao = sessaoDaRequisicao(req);
  if (!sessao.valido) return sendError(res, 401, 'Sessão inválida.');
  if (!resolveMoviePath(query.arquivo)) return sendError(res, 404, 'Arquivo não encontrado.');

  const segundos = Number(query.t);
  if (!Number.isFinite(segundos) || segundos < 0) {
    return sendError(res, 400, 'Parâmetro "t" inválido.');
  }

  salvarTempo(sessao.dados.uid, query.arquivo, segundos);
  res.writeHead(204);
  res.end();
}

// GET /user/prefs -> { volume?, audioIdioma? } (só as chaves já salvas)
function handlePrefsGet(req, res) {
  const sessao = sessaoDaRequisicao(req);
  if (!sessao.valido) return sendError(res, 401, 'Sessão inválida.');

  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obterPrefs(sessao.dados.uid)));
}

// POST (sendBeacon) /user/prefs/save?volume=<0..1>&audioIdioma=<cod>
// Atualização PARCIAL: manda só o que mudou. Valores VALIDADOS aqui — nunca
// confia no cliente (é o que grava no disco por usuário).
function handlePrefsSave(req, res, query) {
  const sessao = sessaoDaRequisicao(req);
  if (!sessao.valido) return sendError(res, 401, 'Sessão inválida.');

  const parciais = {};

  if (query.volume !== undefined) {
    const v = Number(query.volume);
    if (!Number.isFinite(v) || v < 0 || v > 1) return sendError(res, 400, 'Parâmetro "volume" inválido (0..1).');
    parciais.volume = v;
  }

  if (query.audioIdioma !== undefined) {
    // Código de idioma tipo "por", "eng", "spa" (ou 2 letras). Só letras
    // minúsculas, curto — o resto é recusado pra não gravar lixo.
    const idioma = String(query.audioIdioma).toLowerCase();
    if (!/^[a-z]{1,8}$/.test(idioma)) return sendError(res, 400, 'Parâmetro "audioIdioma" inválido.');
    parciais.audioIdioma = idioma;
  }

  if (Object.keys(parciais).length === 0) {
    return sendError(res, 400, 'Nada a salvar (informe volume e/ou audioIdioma).');
  }

  salvarPrefs(sessao.dados.uid, parciais);
  res.writeHead(204);
  res.end();
}

module.exports = { handleWatchTimeGet, handleWatchTimeSave, handlePrefsGet, handlePrefsSave };
