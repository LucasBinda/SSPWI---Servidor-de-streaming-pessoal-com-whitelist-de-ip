const fs = require('fs');
const path = require('path');
const { loadSettings } = require('./settings');
const { forgetVideo } = require('./mediaTools');
const { coverPicker } = require('./coverPicker');
const { lerJson, salvarJson } = require('./jsonStore');
const { CATALOG_PATH, MOVIES_DIR, COVERS_DIR } = require('./paths');

// Lógica de DOMÍNIO do catálogo (separada do HTTP, que fica em
// routes/movies.js): varredura do acervo em disco, sincronização com
// data/catalog.json e derivações (título a partir do nome, versão de capa,
// tipo MIME). O que é "responder uma requisição" mora na rota; o que é
// "o que é o catálogo" mora aqui.

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
function scanMoviesDir(dir = MOVIES_DIR, baseDir = dir) {
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

  const listaAtual = lerJson(CATALOG_PATH, [], Array.isArray);

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
    salvarJson(CATALOG_PATH, listaAtualizada);

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

module.exports = {
  scanMoviesDir,
  sincronizarCatalogo,
  tituloAPartirDoNome,
  capaComVersao,
  getMimeType,
  VIDEO_EXTENSIONS,
};
