const fs = require('fs');
const path = require('path');
const { loadSettings } = require('./settings');
const { forgetVideo } = require('./mediaTools');
const { coverPicker } = require('./coverPicker');
const { lerJson, salvarJson } = require('./jsonStore');
const { CATALOG_PATH, MOVIES_DIR, COVERS_DIR } = require('./paths');
const { logManager } = require('./logManager');

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
      logManager.info('catálogo',
        `${faltando.length} filme(s) novo(s) adicionado(s) em data/catalog.json ` +
        `(preencha descrição/capa quando quiser): ${faltando.join(', ')}`
      );
    }
    if (removidos.length > 0) {
      logManager.info('catálogo',
        `${removidos.length} entrada(s) removida(s) de data/catalog.json ` +
        `(arquivo não existe mais em media/movies/): ${removidos.map((r) => r.arquivo).join(', ')}`
      );
    }
  } catch (err) {
    logManager.registrarErro('catálogo', `falha ao atualizar data/catalog.json: ${err.message}`);
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

// Tokens de "ruído" de nome de release (resolução, codec, fonte, idioma-tag,
// grupo de scene...). limparNome corta o nome A PARTIR do primeiro deles —
// é o que transforma "Game of Thrones S01E05 The Wolf 1080p x265 HEVC-PSA"
// em "Game of Thrones S01E05 The Wolf". Não pega SxxExx nem "Chapter N", que
// são parte legítima do título do episódio.
const RUIDO_RE = /\b(1080p|2160p|720p|480p|4k|x264|x265|h264|h265|hevc|avc|xvid|bluray|blu-ray|brrip|bdrip|web-?dl|webrip|hdtv|dvdrip|remux|10bit|8bit|dual|dublado|legendado|nacional|5\.1|2\.0|6ch|ac3|eac3|aac|dts|complete|completa|season|temporada)\b/i;

// Frases de ruído que aparecem no COMEÇO do nome de pastas de coleção e não
// fazem parte do título ("COLEÇÃO COMPLETA - Harry Potter" -> "Harry Potter").
const PREFIXO_RUIDO_RE = /^(cole[çc][aã]o completa|colecao completa|complete series|the complete series|cole[çc][aã]o)\s*[-–—:]?\s*/i;

// Normaliza separadores e corta o ruído técnico do fim. Heurística — nomes de
// release variam demais pra acertar sempre. PONTO DE EXTENSÃO: quando houver
// override por arquivo/grupo (catalog.json / futuro data/series.json), ele
// entra por cima disto.
function limparNome(nome) {
  const s = String(nome).replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  const m = s.match(RUIDO_RE);
  const cortado = m ? s.slice(0, m.index) : s;
  // Tira separadores/parênteses soltos que sobraram na ponta do corte.
  return cortado.replace(/[\s\-–—|(:]+$/, '').trim() || s;
}

// Título de um GRUPO (série/coleção) a partir do nome da pasta de nível 1:
// tira a frase de ruído inicial e depois o ruído técnico do fim.
function tituloDeGrupo(pasta) {
  const semPrefixo = String(pasta).replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim().replace(PREFIXO_RUIDO_RE, '');
  return limparNome(semPrefixo) || pasta;
}

// Se o título do item começa com o título do grupo, remove esse prefixo pra
// não repetir ("Game of Thrones S01E05 ..." dentro da série "Game of Thrones"
// vira "S01E05 ..."). Sem match, devolve o título inteiro.
function tituloDoItem(tituloItem, tituloGrupo) {
  if (!tituloGrupo) return tituloItem;
  const rx = new RegExp('^' + tituloGrupo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[-–—:]?\\s*', 'i');
  const curto = tituloItem.replace(rx, '').trim();
  return curto || tituloItem;
}

// Agrupa a lista PLANA de arquivos por pasta de nível 1 (primeiro segmento do
// caminho relativo). Pasta com 1 vídeo -> filme avulso; pasta com vários ->
// série/coleção. É uma camada de APRESENTAÇÃO: não muda como o acervo é
// varrido, sincronizado ou reencodado — só como o catálogo é exibido.
//
// Arquitetura pensada pra crescer sem reescrever:
// - `itens` é uma LISTA ORDENADA. O "próximo episódio" do auto-play (futuro)
//   é simplesmente itens[i+1]; a ordenação natural (S01E05->E06, 001->003)
//   já entrega a sequência certa sem parsear temporada.
// - agrupar por TEMPORADA (futuro) entra como uma sub-quebra de `itens`, sem
//   mexer no id do grupo nem na rota /api/serie.
// - título/capa de grupo hoje são DERIVADOS; um override por grupo (futuro)
//   entra por cima, sem mudar a forma dos dados.
function agruparCatalogo(arquivos, overrides = {}) {
  const grupos = new Map(); // pastaTopo -> [relPaths]
  for (const rel of arquivos) {
    const topo = rel.split('/')[0];
    if (!grupos.has(topo)) grupos.set(topo, []);
    grupos.get(topo).push(rel);
  }

  const montarItem = (rel) => {
    const ov = overrides[rel] || {};
    // O catalog.json guarda um título por arquivo — mas o AUTO-gerado é o nome
    // cru do arquivo (com "1080p x265 ..."). Se o título salvo ainda é esse
    // auto (host não editou), limpamos o ruído de release; se o host
    // customizou à mão, respeitamos a string dele exatamente.
    const auto = tituloAPartirDoNome(rel);
    const titulo = (ov.titulo && ov.titulo !== auto) ? ov.titulo : limparNome(auto);
    return {
      arquivo: rel,
      titulo,
      descricao: ov.descricao || '',
      capa: capaComVersao(ov.capa),
    };
  };

  const entradas = [];
  for (const [topo, rels] of grupos) {
    // Ordenação NATURAL: "10" depois de "9", "S01E05" antes de "S01E06".
    rels.sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' }));

    if (rels.length === 1) {
      const item = montarItem(rels[0]);
      entradas.push({ tipo: 'filme', id: rels[0], ...item });
      continue;
    }

    const tituloGrupo = tituloDeGrupo(topo);
    const itens = rels.map((rel) => {
      const item = montarItem(rel);
      item.titulo = tituloDoItem(item.titulo, tituloGrupo);
      return item;
    });

    entradas.push({
      tipo: 'serie',
      id: topo,                 // pasta de nível 1 = id estável do grupo
      titulo: tituloGrupo,
      capa: itens[0].capa,      // capa do grupo = capa do 1º item (por ora)
      total: itens.length,
      itens,
    });
  }

  return entradas;
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

// A limpeza do catálogo na varredura global (remover filmes que sumiram do
// disco) mora no store dedicado lib/stores/catalogStore.js, que reusa
// scanMoviesDir/sincronizarCatalogo exportados aqui embaixo.
module.exports = {
  scanMoviesDir,
  sincronizarCatalogo,
  tituloAPartirDoNome,
  agruparCatalogo,
  capaComVersao,
  getMimeType,
  VIDEO_EXTENSIONS,
};
