const { VIDA_MAXIMA_DIAS } = require('./sessionToken');
const { lerJson, salvarJson } = require('./jsonStore');
const { WATCHTIME_PATH } = require('./paths');
const { logManager } = require('./logManager');

// Persistência de tempo de exibição (watch time) por usuário.
//
// Nota arquitetural: os vídeos ficam no file system (media/movies/); a
// minutagem de cada usuário fica SEPARADA, aqui, em data/watchtime.json —
// o "banco de dados" deste projeto zero-dependência, mesmo padrão do
// catalog.json e do reencode-state.json.
//
// Estrutura: { [uid]: { [arquivoRel]: { segundos, atualizadoEm } } }
// O uid é o do cookie de login persistente (lib/sessionToken.js) — é o que
// faz a minutagem sobreviver a troca de IP e de aba, enquanto o login
// viver. Como nenhum login passa de VIDA_MAXIMA_DIAS, entradas sem
// atualização há mais tempo que isso pertencem a logins mortos — são
// podadas automaticamente a cada gravação, então o arquivo não cresce
// pra sempre.

const RETENCAO_MS = VIDA_MAXIMA_DIAS * 24 * 60 * 60 * 1000;

function carregar() {
  return lerJson(WATCHTIME_PATH, {}, (d) => d && typeof d === 'object' && !Array.isArray(d));
}

function podar(dados) {
  const limite = Date.now() - RETENCAO_MS;
  for (const [uid, filmes] of Object.entries(dados)) {
    for (const [arquivo, registro] of Object.entries(filmes)) {
      if (!registro || typeof registro.atualizadoEm !== 'number' || registro.atualizadoEm < limite) {
        delete filmes[arquivo];
      }
    }
    if (Object.keys(filmes).length === 0) delete dados[uid];
  }
}

// Gravação leve: read-modify-write síncrono (single-thread do Node garante
// atomicidade dentro do tick) num arquivo pequeno — pra um servidor
// pessoal, é mais simples e mais robusto que manter estado em memória com
// flush periódico (nada se perde num crash).
function salvarTempo(uid, arquivo, segundos) {
  const dados = carregar();
  podar(dados);

  if (!dados[uid]) dados[uid] = {};
  dados[uid][arquivo] = {
    segundos: Math.max(0, Math.floor(segundos)),
    atualizadoEm: Date.now(),
  };

  try {
    salvarJson(WATCHTIME_PATH, dados);
  } catch (err) {
    logManager.registrarErro('watchtime', `falha ao salvar: ${err.message}`);
  }
}

function obterTempo(uid, arquivo) {
  const filmes = carregar()[uid];
  const registro = filmes && filmes[arquivo];
  if (!registro) return 0;
  // Registro mais velho que a vida máxima de um cookie pertence a um login
  // morto — nunca devolve, mesmo que a varredura de limpeza ainda não
  // tenha passado por ele (a leitura é blindada por conta própria).
  if (typeof registro.atualizadoEm !== 'number' || registro.atualizadoEm < Date.now() - RETENCAO_MS) {
    return 0;
  }
  return registro.segundos;
}

// Quando o worker de re-encode renomeia um arquivo (.mkv -> .mp4), a
// minutagem de TODOS os usuários naquele filme acompanha o nome novo.
function renomearArquivo(relAntigo, relNovo) {
  const dados = carregar();
  let mudou = false;
  for (const filmes of Object.values(dados)) {
    if (filmes[relAntigo]) {
      filmes[relNovo] = filmes[relAntigo];
      delete filmes[relAntigo];
      mudou = true;
    }
  }
  if (mudou) {
    try {
      salvarJson(WATCHTIME_PATH, dados);
    } catch (err) {
      logManager.registrarErro('watchtime', `falha ao renomear registros: ${err.message}`);
    }
  }
}

// Varredura de limpeza chamada periodicamente pelo server.js (boot +
// intervalo), INDEPENDENTE de tráfego: sem isso, a poda só rodava dentro
// de salvarTempo — se ninguém mais gravasse nada, minutagem de logins
// mortos ficava no disco pra sempre. Cookie morto => dados somem em no
// máximo RETENCAO_MS + o intervalo da varredura.
function podarOrfaos() {
  const dados = carregar();
  const antes = JSON.stringify(dados);
  podar(dados);
  if (JSON.stringify(dados) === antes) return;

  try {
    salvarJson(WATCHTIME_PATH, dados);
    logManager.info('watchtime', 'minutagem de logins expirados removida');
  } catch (err) {
    logManager.registrarErro('watchtime', `falha ao podar órfãos: ${err.message}`);
  }
}

module.exports = { salvarTempo, obterTempo, renomearArquivo, podarOrfaos };
