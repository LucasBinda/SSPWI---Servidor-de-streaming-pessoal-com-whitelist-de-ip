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

    res.writeHead(200, { 'Content-Type': getMime(filePath) });
    fs.createReadStream(filePath).pipe(res);
  });
}

module.exports = { serveStatic };
