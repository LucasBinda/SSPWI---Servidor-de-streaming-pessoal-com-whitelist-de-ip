const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { salvarTempo, obterTempo, renomearArquivo, podarOrfaos } = require('../lib/watchTime');
const { WATCHTIME_PATH } = require('../lib/paths');

// watchTime grava no data/watchtime.json REAL (o caminho é fixo). Pra não
// poluir os dados de produção, guardamos o conteúdo original antes de tudo e
// restauramos no fim; cada teste começa com o arquivo zerado.
let backup = null;
before(() => {
  backup = fs.existsSync(WATCHTIME_PATH) ? fs.readFileSync(WATCHTIME_PATH) : null;
});
after(() => {
  if (backup !== null) fs.writeFileSync(WATCHTIME_PATH, backup);
  else fs.rmSync(WATCHTIME_PATH, { force: true });
});
beforeEach(() => fs.writeFileSync(WATCHTIME_PATH, '{}\n'));

const DIA_MS = 24 * 60 * 60 * 1000;

test('salvar e obter a minutagem de um usuário', () => {
  salvarTempo('user1', 'filme/a.mp4', 123.7);
  assert.strictEqual(obterTempo('user1', 'filme/a.mp4'), 123); // floor
});

test('uid ou arquivo desconhecido -> 0', () => {
  salvarTempo('user1', 'filme/a.mp4', 100);
  assert.strictEqual(obterTempo('outro', 'filme/a.mp4'), 0);
  assert.strictEqual(obterTempo('user1', 'filme/inexistente.mp4'), 0);
});

test('segundos negativos são normalizados pra 0', () => {
  salvarTempo('user1', 'filme/a.mp4', -50);
  assert.strictEqual(obterTempo('user1', 'filme/a.mp4'), 0);
});

test('registro velho (login morto) -> leitura devolve 0 mesmo antes da poda', () => {
  // grava um registro com atualizadoEm bem no passado, direto no arquivo
  const antigo = { user1: { 'filme/a.mp4': { segundos: 500, atualizadoEm: Date.now() - 30 * DIA_MS } } };
  fs.writeFileSync(WATCHTIME_PATH, JSON.stringify(antigo));
  assert.strictEqual(obterTempo('user1', 'filme/a.mp4'), 0);
});

test('renomearArquivo move a minutagem pro nome novo, de todos os usuários', () => {
  salvarTempo('user1', 'velho.mkv', 100);
  salvarTempo('user2', 'velho.mkv', 200);
  renomearArquivo('velho.mkv', 'novo.mp4');
  assert.strictEqual(obterTempo('user1', 'velho.mkv'), 0);
  assert.strictEqual(obterTempo('user1', 'novo.mp4'), 100);
  assert.strictEqual(obterTempo('user2', 'novo.mp4'), 200);
});

test('podarOrfaos remove entradas de logins expirados', () => {
  const dados = {
    vivo: { 'a.mp4': { segundos: 10, atualizadoEm: Date.now() } },
    morto: { 'b.mp4': { segundos: 20, atualizadoEm: Date.now() - 30 * DIA_MS } },
  };
  fs.writeFileSync(WATCHTIME_PATH, JSON.stringify(dados));
  podarOrfaos();
  const depois = JSON.parse(fs.readFileSync(WATCHTIME_PATH, 'utf-8'));
  assert.ok(depois.vivo, 'login vivo permanece');
  assert.ok(!depois.morto, 'login morto foi removido');
});
