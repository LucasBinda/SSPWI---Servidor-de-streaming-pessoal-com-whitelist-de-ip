const fs = require('fs');
const path = require('path');
const { enfileirarConversoes } = require('../lib/reencodeWorker');
const { coverPicker } = require('../lib/coverPicker');
const { servirArquivoComRange } = require('../lib/httpRange');
const { MOVIES_DIR } = require('../lib/paths');
const { logManager } = require('../lib/logManager');
const {
  scanMoviesDir,
  sincronizarCatalogo,
  agruparCatalogo,
  getMimeType,
} = require('../lib/catalog');

// Camada HTTP do catálogo e do streaming. A lógica de domínio (o que É o
// catálogo, como se varre o acervo, como se sincroniza, como se agrupa) mora
// em lib/catalog.js — aqui só se traduz isso em requisição/resposta.

// Varre o acervo, sincroniza data/catalog.json, garante capas e devolve o
// catálogo AGRUPADO (filmes avulsos + séries/coleções). Reúso entre
// /api/movies (lista, sem itens) e /api/serie (um grupo, com itens).
function montarCatalogoAgrupado() {
  const arquivos = scanMoviesDir(MOVIES_DIR);
  const listaSincronizada = sincronizarCatalogo(arquivos);

  // Fase 2: todo vídeo entra na fila de avaliação em background — o worker
  // sonda as faixas e converte pra H.264/AAC estéreo o que não toca no
  // navegador (inclusive HEVC dentro de .mp4), deixando o resto intocado.
  // Barato e idempotente: o worker ignora o que já está na fila, concluído
  // ou com falha registrada.
  enfileirarConversoes(arquivos);

  // Fase 4: gera capa (frame aleatório do próprio filme) pra toda entrada
  // sem capa ou com capa local que não existe mais em disco.
  coverPicker.garantirCapas(listaSincronizada);

  const overrides = {};
  listaSincronizada.forEach((item) => {
    if (item.arquivo) overrides[item.arquivo] = item;
  });

  const entradas = agruparCatalogo(arquivos, overrides);
  entradas.sort((a, b) => a.titulo.localeCompare(b.titulo, 'pt-BR'));
  return entradas;
}

// GET /api/movies -> catálogo agrupado pra a grade inicial. Séries entram como
// um card só (sem a lista de episódios, que é pesada e só interessa na página
// da série); filmes avulsos vêm completos.
function handleMoviesApi(req, res) {
  try {
    const entradas = montarCatalogoAgrupado().map((e) => {
      if (e.tipo === 'serie') {
        const { itens, ...resumo } = e; // tira os episódios da resposta da lista
        return resumo;
      }
      return e;
    });

    const body = JSON.stringify(entradas);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  } catch (err) {
    logManager.registrarErro('catálogo', `falha ao montar o catálogo: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ erro: 'Não foi possível carregar o catálogo.' }));
  }
}

// GET /api/serie?grupo=<id> -> um grupo (série/coleção) COM a lista ordenada
// de episódios. O `grupo` é casado contra os grupos derivados do acervo (não
// é usado pra tocar disco direto), então não há risco de path traversal — os
// `arquivo` dos itens são caminhos já validados na varredura, e o /stream
// revalida cada um em resolveMoviePath.
function handleSerieApi(req, res, query) {
  try {
    const grupo = montarCatalogoAgrupado().find((e) => e.tipo === 'serie' && e.id === query.grupo);
    if (!grupo) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ erro: 'Série não encontrada.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(grupo));
  } catch (err) {
    logManager.registrarErro('catálogo', `falha ao montar a série: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ erro: 'Não foi possível carregar a série.' }));
  }
}

// Resolve um caminho relativo (vindo de query.arquivo) pra um caminho
// absoluto DENTRO de media/movies, ou retorna null se for inválido/ausente.
// É a ÚNICA função que decide "esse caminho é seguro" — tanto o /stream
// quanto o /media/* e o /watchtime/* usam esta mesma validação, em vez de
// reimplementar a checagem de path traversal em vários lugares.
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

  // Toda a mecânica de range (e a robustez a cabeçalhos malformados) mora em
  // lib/httpRange.js, compartilhada com a rota de faixa de áudio.
  servirArquivoComRange(req, res, filePath, getMimeType(filePath));
}

module.exports = { handleMoviesApi, handleSerieApi, handleStream, resolveMoviePath };
