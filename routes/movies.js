const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const CATALOG_PATH = path.join(__dirname, '..', 'data', 'catalog.json');
const MOVIES_DIR = path.join(__dirname, '..', 'media', 'movies');

// Extensões de vídeo reconhecidas ao escanear a pasta media/movies.
// MKV funciona no servidor, mas nem todo navegador reproduz o container
// (Safari nunca toca; Chrome/Firefox dependem do codec interno). Se der
// problema na hora de assistir, converta para mp4 (veja o README).
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.ogg'];

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ogg': 'video/ogg',
};

function getMimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// Varre media/movies recursivamente e devolve os caminhos relativos
// (com "/" mesmo no Windows) de todos os arquivos de vídeo, incluindo
// os que estão dentro de subpastas.
function scanMoviesDir(dir, baseDir = dir) {
  let results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(scanMoviesDir(fullPath, baseDir));
    } else if (VIDEO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
      const relPath = path.relative(baseDir, fullPath).split(path.sep).join('/');
      results.push(relPath);
    }
  }
  return results;
}

// data/catalog.json é opcional: serve só para sobrescrever título, descrição
// ou capa de um arquivo específico. Se o arquivo não existir (ou não tiver
// uma entrada para um filme), o título é gerado a partir do nome do arquivo.
function loadOverrides() {
  try {
    const raw = fs.readFileSync(CATALOG_PATH, 'utf-8');
    const lista = JSON.parse(raw);
    const map = {};
    lista.forEach((item) => {
      if (item.arquivo) map[item.arquivo] = item;
    });
    return map;
  } catch (err) {
    return {};
  }
}

function tituloAPartirDoNome(relPath) {
  const semExtensao = path.basename(relPath, path.extname(relPath));
  return semExtensao
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// GET /api/movies -> monta o catálogo escaneando media/movies/ (incluindo
// subpastas) e aplicando eventuais overrides de data/catalog.json
router.get('/api/movies', (req, res) => {
  try {
    const arquivos = scanMoviesDir(MOVIES_DIR);
    const overrides = loadOverrides();

    const catalogo = arquivos.map((relPath) => {
      const override = overrides[relPath] || {};
      return {
        id: override.id || relPath,
        titulo: override.titulo || tituloAPartirDoNome(relPath),
        descricao: override.descricao || '',
        capa: override.capa || '',
        arquivo: relPath,
      };
    });

    catalogo.sort((a, b) => a.titulo.localeCompare(b.titulo, 'pt-BR'));
    res.json(catalogo);
  } catch (err) {
    console.error('Falha ao montar o catálogo:', err.message);
    res.status(500).json({ erro: 'Não foi possível carregar o catálogo.' });
  }
});

// GET /stream?arquivo=<caminho relativo dentro de media/movies>
// Usa query string (em vez de segmento de rota) para poder aceitar
// caminhos com subpastas, ex: arquivo=acao%2Ffilme.mp4
router.get('/stream', (req, res) => {
  const relPath = req.query.arquivo;
  if (!relPath) {
    return res.status(400).send('Parâmetro "arquivo" ausente.');
  }

  // Resolve o caminho final e garante que ele continua DENTRO de
  // MOVIES_DIR — é isso que impede "../../etc/passwd" e afins, mesmo
  // com subpastas permitidas.
  const filePath = path.normalize(path.join(MOVIES_DIR, relPath));
  const movimentsDirComBarra = MOVIES_DIR + path.sep;
  if (!filePath.startsWith(movimentsDirComBarra)) {
    return res.status(400).send('Caminho inválido.');
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return res.status(404).send('Arquivo não encontrado.');
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  const contentType = getMimeType(filePath);

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : fileSize - 1;

    if (isNaN(start) || start >= fileSize) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      return res.end();
    }

    const chunkSize = end - start + 1;
    const stream = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
    });

    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

module.exports = router;
