const fs = require('fs');
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function getMime(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// Cache do navegador por tipo de arquivo:
// - .html: no-cache (revalida sempre) — a estrutura da página precisa
//   refletir na hora quando o host edita o HTML; o custo é ínfimo (arquivos
//   pequenos, e revalidação 304 é barata);
// - resto (css/js/imagens/capas): 5 min. As capas trocam de URL via ?v=
//   (mtime, ver capaComVersao), então cache mais longo nelas é seguro; pra
//   css/js, 5 min é curto o bastante pra uma edição aparecer logo após um
//   restart e longo o bastante pra poupar as revisitas.
function getCacheControl(filePath) {
  return path.extname(filePath).toLowerCase() === '.html'
    ? 'no-cache'
    : 'public, max-age=300';
}

// Serve um arquivo estático de dentro de rootDir. relPath vem direto da URL,
// então é preciso decodificar e, principalmente, garantir que o caminho
// final continua dentro de rootDir (mesma proteção usada no streaming).
function serveStatic(rootDir, relPath, res) {
  let decoded;
  try {
    decoded = decodeURIComponent(relPath);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('URL inválida.');
  }

  const filePath = path.normalize(path.join(rootDir, decoded));
  const rootComBarra = rootDir + path.sep;

  if (!filePath.startsWith(rootComBarra) && filePath !== rootDir) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Caminho inválido.');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Não encontrado.');
    }

    res.writeHead(200, {
      'Content-Type': getMime(filePath),
      'Cache-Control': getCacheControl(filePath),
    });
    const stream = fs.createReadStream(filePath);
    // 'error' tratado: um erro de leitura no meio do envio (arquivo removido,
    // falha de disco) emitiria 'error' sem ouvinte e derrubaria o processo.
    stream.on('error', (streamErr) => {
      console.error(`[static] erro ao ler ${filePath}:`, streamErr.message);
      res.destroy(streamErr);
    });
    stream.pipe(res);
  });
}

module.exports = { serveStatic };
