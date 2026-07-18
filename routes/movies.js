const fs = require('fs');
const path = require('path');
const { loadSettings } = require('../lib/settings');
const { forgetVideo } = require('../lib/mediaTools');
const { enfileirarNaoMp4 } = require('../lib/reencodeWorker');
const { coverPicker } = require('../lib/coverPicker');

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
// media/movies/ com o que já existe no arquivo:
//
// - qualquer filme encontrado que ainda não tenha uma entrada lá ganha um
//   "rascunho" automático (título gerado a partir do nome do arquivo,
//   descrição e capa vazias);
// - qualquer entrada cujo arquivo não existe mais em media/movies/ é
//   removida, DESDE QUE `removerFilmesAusentesDoCatalogo` esteja true em
//   config/settings.json (ativado por padrão — o host pode desativar se
//   preferir manter entradas de filmes removidos temporariamente).
//
// O resultado é gravado de volta em data/catalog.json quando há qualquer
// mudança (adição ou remoção).
function sincronizarCatalogo(arquivosEncontrados) {
  const settings = loadSettings();

  let listaAtual = [];
  try {
    const raw = fs.readFileSync(CATALOG_PATH, 'utf-8');
    listaAtual = JSON.parse(raw);
    if (!Array.isArray(listaAtual)) listaAtual = [];
  } catch (err) {
    listaAtual = [];
  }

  const encontradosSet = new Set(arquivosEncontrados);
  const jaExistem = new Set(listaAtual.map((item) => item.arquivo));

  const faltando = arquivosEncontrados.filter((relPath) => !jaExistem.has(relPath));

  let listaBase = listaAtual;
  let removidos = [];

  if (settings.removerFilmesAusentesDoCatalogo) {
    removidos = listaAtual.filter((item) => item.arquivo && !encontradosSet.has(item.arquivo));
    listaBase = listaAtual.filter((item) => !item.arquivo || encontradosSet.has(item.arquivo));

    // Interliga com o cache de mídia: um filme removido de media/movies/
    // não deve deixar legenda extraída nem metadado de ffprobe órfão pra
    // trás (ver forgetVideo em lib/mediaTools.js). Usa o mesmo
    // path.normalize(path.join(MOVIES_DIR, ...)) de resolveMoviePath pra
    // bater exatamente com a chave de cache usada durante a reprodução —
    // não dá pra chamar resolveMoviePath aqui porque ele exige que o
    // arquivo ainda exista, e a essa altura ele já foi removido do disco.
    for (const item of removidos) {
      forgetVideo(path.normalize(path.join(MOVIES_DIR, item.arquivo)));
      // A capa automática gerada pra esse filme também não pode ficar órfã.
      coverPicker.removerCapa(item.arquivo);
    }
  }

  if (faltando.length === 0 && removidos.length === 0) {
    return listaAtual;
  }

  const novasEntradas = faltando.map((relPath) => ({
    arquivo: relPath,
    titulo: tituloAPartirDoNome(relPath),
    descricao: '',
    capa: '',
  }));

  const listaAtualizada = [...listaBase, ...novasEntradas];

  try {
    fs.writeFileSync(CATALOG_PATH, JSON.stringify(listaAtualizada, null, 2) + '\n', 'utf-8');

    if (faltando.length > 0) {
      console.log(
        `[catálogo] ${faltando.length} filme(s) novo(s) adicionado(s) em data/catalog.json ` +
        `(preencha descrição/capa quando quiser): ${faltando.join(', ')}`
      );
    }
    if (removidos.length > 0) {
      console.log(
        `[catálogo] ${removidos.length} entrada(s) removida(s) de data/catalog.json ` +
        `(arquivo não existe mais em media/movies/): ${removidos.map((r) => r.arquivo).join(', ')}`
      );
    }
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

const COVERS_DIR = path.join(__dirname, '..', 'media', 'covers');

// Anexa a versão (mtime) às capas locais na RESPOSTA da API — a URL muda
// junto com o arquivo, então o navegador nunca mostra capa velha de cache.
// Importa principalmente com trocarCapasAutoNoCatalogo ligado: a capa é
// substituída em disco mantendo o mesmo nome, e sem isso a URL idêntica
// deixaria o navegador reaproveitar a imagem anterior. O catalog.json em
// si guarda a URL limpa; a versão só existe na resposta.
function capaComVersao(capa) {
  if (!capa || !capa.startsWith('/covers/')) return capa || '';
  const abs = path.normalize(path.join(COVERS_DIR, capa.replace('/covers/', '')));
  if (!abs.startsWith(COVERS_DIR + path.sep)) return capa;
  try {
    return `${capa}?v=${Math.floor(fs.statSync(abs).mtimeMs)}`;
  } catch {
    return capa;
  }
}

// GET /api/movies -> monta o catálogo escaneando media/movies/ (incluindo
// subpastas) e aplicando eventuais overrides de data/catalog.json
function handleMoviesApi(req, res) {
  try {
    const arquivos = scanMoviesDir(MOVIES_DIR);
    const listaSincronizada = sincronizarCatalogo(arquivos);

    // Fase 2: qualquer vídeo novo que não seja .mp4 entra na fila de
    // conversão em background (barato e idempotente — o worker ignora o
    // que já está na fila, concluído ou com falha registrada).
    enfileirarNaoMp4(arquivos);

    // Fase 4: gera capa (frame aleatório do próprio filme) pra toda entrada
    // sem capa ou com capa local que não existe mais em disco.
    coverPicker.garantirCapas(listaSincronizada);

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
        capa: capaComVersao(override.capa),
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

// Resolve um caminho relativo (vindo de query.arquivo) pra um caminho
// absoluto DENTRO de media/movies, ou retorna null se for inválido/ausente.
// Extraído do handleStream original pra virar a ÚNICA função que decide
// "esse caminho é seguro" — tanto o /stream quanto o /media/* usam esta
// mesma validação, em vez de reimplementar a checagem de path traversal
// em dois lugares.
function resolveMoviePath(relPath) {
  if (!relPath) return null;

  const filePath = path.normalize(path.join(MOVIES_DIR, relPath));
  const moviesDirComBarra = MOVIES_DIR + path.sep;
  if (!filePath.startsWith(moviesDirComBarra)) return null;

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;

  return filePath;
}

// GET /stream?arquivo=<caminho relativo dentro de media/movies>
// query já vem interpretado (objeto) de quem chamou esta função.
function handleStream(req, res, query) {
  const relPath = query.arquivo;
  if (!relPath) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Parâmetro "arquivo" ausente.');
  }

  const filePath = resolveMoviePath(relPath);
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Arquivo não encontrado ou caminho inválido.');
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

module.exports = { handleMoviesApi, handleStream, resolveMoviePath, scanMoviesDir, sincronizarCatalogo, MOVIES_DIR };
