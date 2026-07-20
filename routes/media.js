const fs = require('fs');
const { resolveMoviePath } = require('./movies');
const { probeTracks, getSubtitle, getAudioTrack } = require('../lib/mediaTools');

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

// GET /media/audio?arquivo=<relPath>&faixa=<índice>
// Extrai (com cache, ver lib/mediaTools.js) a faixa de áudio pedida como
// .m4a e serve com range requests. É a metade servidor da troca de
// dublagem: o player toca esta faixa num <audio> sincronizado com o vídeo
// mutado — navegador nenhum além do Safari expõe troca nativa de faixa.
function handleMediaAudio(req, res, query) {
  const filePath = resolveMoviePath(query.arquivo);
  if (!filePath) return sendError(res, 404, 'Arquivo não encontrado ou caminho inválido.');

  const faixa = Number(query.faixa);
  if (!Number.isInteger(faixa) || faixa < 0) {
    return sendError(res, 400, 'Parâmetro "faixa" inválido.');
  }

  getAudioTrack(filePath, faixa)
    .then((m4aPath) => servirComRange(req, res, m4aPath, 'audio/mp4'))
    .catch((err) => {
      console.error('[media] falha ao extrair faixa de áudio:', err.message);
      sendError(res, 500, 'Não foi possível extrair a faixa de áudio.');
    });
}

// Serve um arquivo com suporte a range requests (mesma mecânica do /stream
// em routes/movies.js) — sem isso o <audio> não consegue fazer seek, e a
// sincronia com o vídeo depende de seek o tempo todo.
function servirComRange(req, res, filePath, contentType) {
  const fileSize = fs.statSync(filePath).size;
  const range = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : fileSize - 1;

    if (isNaN(start) || start >= fileSize) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      return res.end();
    }

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': contentType,
    });
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }

  res.writeHead(200, {
    'Content-Length': fileSize,
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(filePath).pipe(res);
}

module.exports = { handleMediaTracks, handleMediaSubtitle, handleMediaAudio };
