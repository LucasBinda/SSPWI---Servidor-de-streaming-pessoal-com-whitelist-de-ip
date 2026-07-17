const { sessaoDaRequisicao } = require('../lib/sessionToken');
const { resolveMoviePath } = require('./movies');
const { salvarTempo, obterTempo } = require('../lib/watchTime');

// Rotas de watch time. As duas assumem que whitelist + sessão já passaram
// no server.js — aqui só extraímos o uid do cookie (pra saber DE QUEM é a
// minutagem) e validamos o arquivo com o mesmo resolveMoviePath de sempre
// (nada de gravar chave de arquivo que não existe no acervo).

function sendError(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg);
}

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

// POST (sendBeacon) ou GET /watchtime/save?arquivo=<relPath>&t=<segundos>
// Requisição de atualização leve: tudo viaja na query string, corpo vazio,
// resposta 204 sem conteúdo — o custo é praticamente só o cabeçalho HTTP.
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

module.exports = { handleWatchTimeGet, handleWatchTimeSave };
