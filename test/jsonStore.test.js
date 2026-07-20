const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lerJson, salvarJson } = require('../lib/jsonStore');

// Arquivo temporário isolado por teste (nunca toca os dados reais do projeto).
const tmp = path.join(os.tmpdir(), `sspwi-jsonstore-${process.pid}.json`);
afterEach(() => fs.rmSync(tmp, { force: true }));

test('round-trip: salva e lê o mesmo objeto', () => {
  salvarJson(tmp, { a: 1, lista: [1, 2, 3], texto: 'ção' });
  assert.deepStrictEqual(lerJson(tmp, null), { a: 1, lista: [1, 2, 3], texto: 'ção' });
});

test('lerJson de arquivo inexistente -> padrão', () => {
  assert.deepStrictEqual(lerJson('/nao/existe/nunca.json', { padrao: true }), { padrao: true });
});

test('lerJson de JSON corrompido -> padrão (não lança)', () => {
  fs.writeFileSync(tmp, '{ isso não é json ][');
  assert.deepStrictEqual(lerJson(tmp, []), []);
});

test('validador rejeita tipo errado -> padrão', () => {
  salvarJson(tmp, { naoEArray: true });
  assert.deepStrictEqual(lerJson(tmp, [], Array.isArray), []);
});

test('validador aceita tipo certo -> valor lido', () => {
  salvarJson(tmp, [1, 2]);
  assert.deepStrictEqual(lerJson(tmp, [], Array.isArray), [1, 2]);
});

test('escrita atômica não deixa .tmp órfão', () => {
  salvarJson(tmp, { ok: 1 });
  const dir = path.dirname(tmp);
  const orfaos = fs.readdirSync(dir).filter((n) => n.startsWith(path.basename(tmp)) && n.endsWith('.tmp'));
  assert.deepStrictEqual(orfaos, []);
});

test('salvarJson sobrescreve conteúdo anterior por completo', () => {
  salvarJson(tmp, { a: 1, b: 2 });
  salvarJson(tmp, { c: 3 });
  assert.deepStrictEqual(lerJson(tmp, null), { c: 3 });
});
