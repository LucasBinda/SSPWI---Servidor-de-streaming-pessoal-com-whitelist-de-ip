const fs = require('fs');
const path = require('path');

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

// data/catalog.json serve para sobrescrever título, descrição ou capa de
// um arquivo específico. Esta função compara o que já está escaneado em
// media/movies/ com o que já existe no arquivo: qualquer filme encontrado
// que ainda não tenha uma entrada lá ganha um "rascunho" automático
// (título gerado a partir do nome do arquivo, descrição e capa vazias),
// que é gravado de volta no arquivo — assim você só precisa completar os
// campos vazios, sem precisar criar a entrada na mão.
function sincronizarCatalogo(arquivosEncontrados) {
  let listaAtual = [];
  try {
    const raw = fs.readFileSync(CATALOG_PATH, 'utf-8');
    listaAtual = JSON.parse(raw);
    if (!Array.isArray(listaAtual)) listaAtual = [];
  } catch (err) {
    listaAtual = [];
  }

  const jaExistem = new Set(listaAtual.map((item) => item.arquivo));
  const faltando = arquivosEncontrados.filter((relPath) => !jaExistem.has(relPath));

  if (faltando.length === 0) {
    return listaAtual;
  }

  const novasEntradas = faltando.map((relPath) => ({
    arquivo: relPath,
    titulo: tituloAPartirDoNome(relPath),
    descricao: '',
    capa: '',
  }));

  const listaAtualizada = [...listaAtual, ...novasEntradas];

  try {
    fs.writeFileSync(CATALOG_PATH, JSON.stringify(listaAtualizada, null, 2) + '\n', 'utf-8');
    console.log(
      `[catálogo] ${faltando.length} filme(s) novo(s) adicionado(s) em data/catalog.json ` +
      `(preencha descrição/capa quando quiser): ${faltando.join(', ')}`
    );
  } catch (err) {
    console.error('Falha ao atualizar data/catalog.json:', err.message);
  }

  return listaAtualizada;
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
function handleMoviesApi(req, res) {
  try {
    const arquivos = scanMoviesDir(MOVIES_DIR);
    const listaSincronizada = sincronizarCatalogo(arquivos);

    const overrides = {};
    listaSincronizada.forEach((item) => {
      if (item.arquivo) overrides[item.arquivo] = item;
    });

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

    const body = JSON.stringify(catalogo);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  } catch (err) {
    console.error('Falha ao montar o catálogo:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ erro: 'Não foi possível carregar o catálogo.' }));
  }
}

// GET /stream?arquivo=<caminho relativo dentro de media/movies>
// query já vem interpretado (objeto) de quem chamou esta função.
function handleStream(req, res, query) {
  const relPath = query.arquivo;
  if (!relPath) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Parâmetro "arquivo" ausente.');
  }

  // Resolve o caminho final e garante que ele continua DENTRO de
  // MOVIES_DIR — impede "../../etc/passwd" e afins, mesmo com subpastas
  // permitidas.
  const filePath = path.normalize(path.join(MOVIES_DIR, relPath));
  const moviesDirComBarra = MOVIES_DIR + path.sep;
  if (!filePath.startsWith(moviesDirComBarra)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Caminho inválido.');
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Arquivo não encontrado.');
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
}

module.exports = { handleMoviesApi, handleStream };
