const fs = require('fs');
const { resolveMoviePath } = require('./movies');
const { probeTracks, getSubtitle } = require('../lib/mediaTools');

function sendError(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg);
}

// GET /media/tracks?arquivo=<relPath>
// Lista as faixas de áudio/legenda e a duração do arquivo (via ffprobe) pro
// front-end montar o menu de configurações do player.
function handleMediaTracks(req, res, query) {
  const filePath = resolveMoviePath(query.arquivo);
  if (!filePath) return sendError(res, 404, 'Arquivo não encontrado ou caminho inválido.');

  probeTracks(filePath)
    .then((tracks) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(tracks));
    })
    .catch((err) => {
      console.error('[media] falha ao sondar faixas:', err.message);
      sendError(res, 500, 'Não foi possível ler as faixas do arquivo.');
    });
}

// GET /media/subtitle?arquivo=<relPath>&sub=<índice>
// Extrai (com cache em disco, ver lib/mediaTools.js) a faixa de legenda
// pedida como WebVTT puro, servida como <track> nativa do <video>.
function handleMediaSubtitle(req, res, query) {
  const filePath = resolveMoviePath(query.arquivo);
  if (!filePath) return sendError(res, 404, 'Arquivo não encontrado ou caminho inválido.');

  const subIndex = Number(query.sub);
  if (!Number.isInteger(subIndex) || subIndex < 0) {
    return sendError(res, 400, 'Parâmetro "sub" inválido.');
  }

  getSubtitle(filePath, subIndex)
    .then((vttPath) => {
      res.writeHead(200, {
        'Content-Type': 'text/vtt; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
      });
      fs.createReadStream(vttPath).pipe(res);
    })
    .catch((err) => {
      console.error('[media] falha ao extrair legenda:', err.message);
      sendError(res, 500, 'Não foi possível extrair a legenda.');
    });
}

module.exports = { handleMediaTracks, handleMediaSubtitle };
