const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const {
  salvarTempo, obterTempo, renomearArquivo, podarOrfaos,
  obterPrefs, salvarPrefs, migrar,
} = require('../lib/userStore');
const { USERS_PATH, WATCHTIME_PATH } = require('../lib/paths');

// userStore grava nos arquivos REAIS (caminhos fixos). Guardamos users.json e
// watchtime.json antes de tudo e restauramos no fim; cada teste começa com o
// users.json zerado. (null = o arquivo não existia; restauramos removendo.)
let bkUsers = null;
let bkWatch = null;
const ler = (p) => (fs.existsSync(p) ? fs.readFileSync(p) : null);
const restaurar = (p, bk) => { if (bk !== null) fs.writeFileSync(p, bk); else fs.rmSync(p, { force: true }); };

before(() => { bkUsers = ler(USERS_PATH); bkWatch = ler(WATCHTIME_PATH); });
after(() => { restaurar(USERS_PATH, bkUsers); restaurar(WATCHTIME_PATH, bkWatch); });
beforeEach(() => fs.writeFileSync(USERS_PATH, '{}\n'));

const DIA_MS = 24 * 60 * 60 * 1000;
const agora = () => Date.now();

test('watch time: salvar e obter (floor nos segundos)', () => {
  salvarTempo('u1', 'filme/a.mp4', 123.7);
  assert.strictEqual(obterTempo('u1', 'filme/a.mp4'), 123);
});

test('watch time: uid/arquivo desconhecido -> 0; negativo -> 0', () => {
  salvarTempo('u1', 'filme/a.mp4', 100);
  assert.strictEqual(obterTempo('outro', 'filme/a.mp4'), 0);
  assert.strictEqual(obterTempo('u1', 'nao/existe.mp4'), 0);
  salvarTempo('u1', 'filme/b.mp4', -50);
  assert.strictEqual(obterTempo('u1', 'filme/b.mp4'), 0);
});

test('watch time: login morto (atualizadoEm velho) -> leitura devolve 0', () => {
  const dados = { u1: { watchtime: { 'a.mp4': { segundos: 500, atualizadoEm: agora() - 30 * DIA_MS } }, prefs: {}, atualizadoEm: agora() - 30 * DIA_MS } };
  fs.writeFileSync(USERS_PATH, JSON.stringify(dados));
  assert.strictEqual(obterTempo('u1', 'a.mp4'), 0);
});

test('renomearArquivo: move o resume de todos os usuários', () => {
  salvarTempo('u1', 'velho.mkv', 100);
  salvarTempo('u2', 'velho.mkv', 200);
  renomearArquivo('velho.mkv', 'novo.mp4');
  assert.strictEqual(obterTempo('u1', 'velho.mkv'), 0);
  assert.strictEqual(obterTempo('u1', 'novo.mp4'), 100);
  assert.strictEqual(obterTempo('u2', 'novo.mp4'), 200);
});

test('prefs: salvar parcial faz merge (volume não apaga audioIdioma)', () => {
  salvarPrefs('u1', { volume: 0.6 });
  salvarPrefs('u1', { audioIdioma: 'por' });
  assert.deepStrictEqual(obterPrefs('u1'), { volume: 0.6, audioIdioma: 'por' });
  salvarPrefs('u1', { volume: 0.3 });
  assert.deepStrictEqual(obterPrefs('u1'), { volume: 0.3, audioIdioma: 'por' });
});

test('prefs: usuário sem dados -> {}; login morto -> {}', () => {
  assert.deepStrictEqual(obterPrefs('ninguem'), {});
  const dados = { u1: { watchtime: {}, prefs: { volume: 0.9 }, atualizadoEm: agora() - 30 * DIA_MS } };
  fs.writeFileSync(USERS_PATH, JSON.stringify(dados));
  assert.deepStrictEqual(obterPrefs('u1'), {});
});

test('watch time e prefs convivem no mesmo usuário', () => {
  salvarTempo('u1', 'a.mp4', 42);
  salvarPrefs('u1', { volume: 0.5 });
  assert.strictEqual(obterTempo('u1', 'a.mp4'), 42);
  assert.deepStrictEqual(obterPrefs('u1'), { volume: 0.5 });
});

test('podarOrfaos: remove o usuário INTEIRO quando o login expira (watch time + prefs)', () => {
  const dados = {
    vivo: { watchtime: { 'a.mp4': { segundos: 10, atualizadoEm: agora() } }, prefs: { volume: 0.4 }, atualizadoEm: agora() },
    morto: { watchtime: { 'b.mp4': { segundos: 20, atualizadoEm: agora() - 30 * DIA_MS } }, prefs: { volume: 0.9 }, atualizadoEm: agora() - 30 * DIA_MS },
  };
  fs.writeFileSync(USERS_PATH, JSON.stringify(dados));
  podarOrfaos();
  const depois = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  assert.ok(depois.vivo, 'usuário vivo permanece');
  assert.ok(!depois.morto, 'usuário morto (login expirado) foi removido inteiro');
});

test('migrar: converte watchtime.json antigo -> users.json (formato novo)', () => {
  // pré-condição: users.json NÃO existe; watchtime.json no formato antigo
  fs.rmSync(USERS_PATH, { force: true });
  const antigo = { uidA: { 'filme.mp4': { segundos: 300, atualizadoEm: agora() } } };
  fs.writeFileSync(WATCHTIME_PATH, JSON.stringify(antigo));

  migrar();

  const novo = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  assert.ok(novo.uidA.watchtime['filme.mp4'], 'watch time migrado pra dentro de .watchtime');
  assert.strictEqual(novo.uidA.watchtime['filme.mp4'].segundos, 300);
  assert.deepStrictEqual(novo.uidA.prefs, {}, 'prefs inicia vazio');
  assert.strictEqual(typeof novo.uidA.atualizadoEm, 'number');
});

test('migrar: idempotente — não sobrescreve users.json já existente', () => {
  fs.writeFileSync(USERS_PATH, JSON.stringify({ jaExiste: { watchtime: {}, prefs: {}, atualizadoEm: agora() } }));
  fs.writeFileSync(WATCHTIME_PATH, JSON.stringify({ outro: { 'x.mp4': { segundos: 1, atualizadoEm: agora() } } }));
  migrar();
  const atual = JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  assert.ok(atual.jaExiste, 'users.json existente preservado');
  assert.ok(!atual.outro, 'não migrou por cima');
});
