const { test } = require('node:test');
const assert = require('node:assert');
const { interpretarRange } = require('../lib/httpRange');

// interpretarRange devolve: null (200 completo), false (416), ou {start,end}.
// Estes casos incluem os que derrubavam o servidor antes da correção
// (Range malformado -> NaN -> exceção não capturada -> crash).
const F = 1000; // tamanho do arquivo fictício

test('sem header -> null (arquivo inteiro)', () => {
  assert.strictEqual(interpretarRange(undefined, F), null);
  assert.strictEqual(interpretarRange('', F), null);
});

test('fim não-numérico ("bytes=0-abc", o bug) -> null, não estoura', () => {
  assert.strictEqual(interpretarRange('bytes=0-abc', F), null);
});

test('início não-numérico ("bytes=abc-100") -> null', () => {
  assert.strictEqual(interpretarRange('bytes=abc-100', F), null);
});

test('ambos lixo -> null', () => {
  assert.strictEqual(interpretarRange('bytes=abc-def', F), null);
  assert.strictEqual(interpretarRange('garbage', F), null);
});

test('range válido -> {start, end}', () => {
  assert.deepStrictEqual(interpretarRange('bytes=0-99', F), { start: 0, end: 99 });
  assert.deepStrictEqual(interpretarRange('bytes=200-499', F), { start: 200, end: 499 });
});

test('fim além do arquivo -> clamp em fileSize-1', () => {
  assert.deepStrictEqual(interpretarRange('bytes=0-999999', F), { start: 0, end: 999 });
});

test('range aberto "bytes=100-" -> até o fim', () => {
  assert.deepStrictEqual(interpretarRange('bytes=100-', F), { start: 100, end: 999 });
});

test('sufixo "bytes=-200" -> últimos 200 bytes', () => {
  assert.deepStrictEqual(interpretarRange('bytes=-200', F), { start: 800, end: 999 });
});

test('sufixo maior que o arquivo -> começa em 0', () => {
  assert.deepStrictEqual(interpretarRange('bytes=-999999', F), { start: 0, end: 999 });
});

test('sufixo zero / vazio -> null', () => {
  assert.strictEqual(interpretarRange('bytes=-0', F), null);
  assert.strictEqual(interpretarRange('bytes=-', F), null);
});

test('início > fim -> false (416)', () => {
  assert.strictEqual(interpretarRange('bytes=500-100', F), false);
});

test('início além do fim do arquivo -> false (416)', () => {
  assert.strictEqual(interpretarRange('bytes=2000-3000', F), false);
  assert.strictEqual(interpretarRange('bytes=1000-1000', F), false); // start === fileSize
});
