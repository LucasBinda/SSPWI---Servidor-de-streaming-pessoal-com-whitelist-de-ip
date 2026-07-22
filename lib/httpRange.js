const fs = require('fs');
const { logManager } = require('./logManager');

// Serve um arquivo com suporte a range requests (HTTP 206), de forma
// robusta a cabeçalhos malformados. Usado pelo /stream (routes/movies.js) e
// pela extração de faixa de áudio (routes/media.js).
//
// O motivo de existir: a versão anterior fazia parseInt sem validar o
// resultado — "Range: bytes=0-abc" virava end=NaN e o createReadStream({end:
// NaN}) lançava uma exceção SÍNCRONA que, sem try/catch no dispatcher,
// derrubava o processo inteiro. Qualquer aparelho da casa (smart TV, app de
// vídeo) com um Range esquisito tirava o servidor do ar pra todo mundo.
//
// Regras de robustez (RFC 7233, simplificada pro caso de um range só):
// - sem Range, ou Range que não casa "bytes=INICIO-FIM": responde 200 com o
//   arquivo inteiro;
// - INICIO ou FIM não-numérico (quando presente): trata como range ausente
//   (200 completo) em vez de estourar;
// - FIM além do fim do arquivo: fica preso (clamp) em fileSize-1;
// - INICIO > FIM, ou INICIO >= fileSize: 416 (Range Not Satisfiable).
function servirArquivoComRange(req, res, filePath, contentType) {
  let fileSize;
  try {
    fileSize = fs.statSync(filePath).size;
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Arquivo não encontrado.');
  }

  const range = interpretarRange(req.headers.range, fileSize);

  // Checagem EXPLÍCITA por valor: `false` (416) também é falsy, então um
  // `if (!range)` o confundiria com `null` (200) e serviria o arquivo
  // inteiro no lugar do 416. São três retornos distintos de propósito.

  // range === null: sem Range válido -> arquivo inteiro (200).
  if (range === null) {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    return enviarStream(fs.createReadStream(filePath), res);
  }

  // range === false: Range presente mas impossível de satisfazer -> 416.
  if (range === false) {
    res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
    return res.end();
  }

  const { start, end } = range;
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': contentType,
  });
  enviarStream(fs.createReadStream(filePath, { start, end }), res);
}

// Encaminha um ReadStream pra resposta com o 'error' TRATADO: sem esse
// handler, um erro de leitura no meio do envio (arquivo removido durante o
// stream, falha de disco) emitiria 'error' sem ouvinte e derrubaria o
// processo inteiro — o mesmo tipo de crash que a validação de range evita
// na entrada.
function enviarStream(stream, res) {
  stream.on('error', (err) => {
    logManager.registrarErro('stream', `erro de leitura durante o envio: ${err.message}`);
    res.destroy(err);
  });
  stream.pipe(res);
}

// Devolve:
//   null            -> sem Range utilizável (o chamador serve 200 completo)
//   false           -> Range presente mas insatisfazível (o chamador serve 416)
//   { start, end }   -> range válido e já normalizado (clamp aplicado)
function interpretarRange(header, fileSize) {
  if (!header) return null;

  // Só uma faixa "bytes=INICIO-FIM"; múltiplas faixas e outras unidades não
  // são suportadas (e viram 200 completo, que é uma resposta válida).
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;

  const inicioStr = m[1];
  const fimStr = m[2];
  if (inicioStr === '' && fimStr === '') return null; // "bytes=-" inútil

  let start;
  let end;
  if (inicioStr === '') {
    // Sufixo "bytes=-N": os últimos N bytes.
    const n = parseInt(fimStr, 10);
    if (!Number.isFinite(n) || n === 0) return null;
    start = Math.max(0, fileSize - n);
    end = fileSize - 1;
  } else {
    start = parseInt(inicioStr, 10);
    end = fimStr === '' ? fileSize - 1 : parseInt(fimStr, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (end > fileSize - 1) end = fileSize - 1; // clamp no fim do arquivo
  }

  if (start > end || start >= fileSize || start < 0) return false;
  return { start, end };
}

module.exports = { servirArquivoComRange, interpretarRange };
