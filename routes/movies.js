const fs = require('fs');
const path = require('path');
const { enfileirarNaoMp4 } = require('../lib/reencodeWorker');
const { coverPicker } = require('../lib/coverPicker');
const { servirArquivoComRange } = require('../lib/httpRange');
const { MOVIES_DIR } = require('../lib/paths');
const {
  scanMoviesDir,
  sincronizarCatalogo,
  tituloAPartirDoNome,
  capaComVersao,
  getMimeType,
} = require('../lib/catalog');

// Camada HTTP do catálogo e do streaming. A lógica de domínio (o que É o
// catálogo, como se varre o acervo, como se sincroniza) mora em
// lib/catalog.js — aqui só se traduz isso em requisição/resposta.

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

module.exports = { handleMoviesApi, handleStream, resolveMoviePath };
