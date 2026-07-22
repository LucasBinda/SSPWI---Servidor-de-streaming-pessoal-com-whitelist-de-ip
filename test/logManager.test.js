const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LogManager, pintar } = require('../lib/logManager');

// Instância própria com pasta temporária — nunca toca no logs/ real.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sspwi-logs-'));
const lm = new LogManager({ logsDir: dir });

// A escrita em arquivo é fire-and-forget (appendFile) — os testes dão uma
// folga pequena antes de ler.
const esperaEscrita = () => new Promise((r) => setTimeout(r, 80));
const linhasDe = (arquivo) => {
  try {
    return fs.readFileSync(path.join(dir, arquivo), 'utf-8').trim().split('\n');
  } catch {
    return [];
  }
};

let forceAntes;
let noColorAntes;
before(() => {
  forceAntes = process.env.FORCE_COLOR;
  noColorAntes = process.env.NO_COLOR;
});
after(() => {
  if (forceAntes === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = forceAntes;
  if (noColorAntes === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = noColorAntes;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pintar: aplica ANSI com FORCE_COLOR e devolve limpo com NO_COLOR', () => {
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = '1';
  const pintado = pintar('vermelho', 'erro');
  assert.ok(pintado.startsWith('\x1b[31m'), 'começa com o código do vermelho');
  assert.ok(pintado.endsWith('\x1b[0m'), 'termina com reset');

  delete process.env.FORCE_COLOR;
  process.env.NO_COLOR = '1';
  assert.strictEqual(pintar('vermelho', 'erro'), 'erro');
  delete process.env.NO_COLOR;
});

test('conexões: deduplicadas por IP dentro da janela', async (t) => {
  t.mock.method(console, 'log', () => {});
  lm.registrarConexao('10.0.0.1');
  lm.registrarConexao('10.0.0.1'); // mesma janela -> não registra
  lm.registrarConexao('10.0.0.2');
  await esperaEscrita();
  const linhas = linhasDe('conexoes.log');
  assert.strictEqual(linhas.length, 2);
  assert.match(linhas[0], / - 10\.0\.0\.1$/);
  assert.match(linhas[1], / - 10\.0\.0\.2$/);
});

test('chamadas: dedup por IP+chamada (chamadas diferentes registram)', async (t) => {
  t.mock.method(console, 'log', () => {});
  lm.registrarChamada('10.0.0.1', 'catálogo');
  lm.registrarChamada('10.0.0.1', 'catálogo'); // dedup
  lm.registrarChamada('10.0.0.1', 'filme: a.mp4');
  await esperaEscrita();
  assert.strictEqual(linhasDe('chamadas.log').length, 2);
});

test('registrarErro: escreve em erros.log com origem e sem ANSI', async (t) => {
  process.env.NO_COLOR = '1'; // console limpo no teste
  t.mock.method(console, 'error', () => {});
  lm.registrarErro('teste', 'deu ruim: X');
  lm.registrarErro('teste', 'deu ruim: X'); // sem dedup: erro repetido registra
  await esperaEscrita();
  const linhas = linhasDe('erros.log');
  assert.strictEqual(linhas.length, 2);
  assert.match(linhas[0], / - teste - deu ruim: X$/);
  assert.ok(!linhas[0].includes('\x1b['), 'arquivo nunca leva código de cor');
  delete process.env.NO_COLOR;
});

test('registrarBloqueio: cada tentativa é uma linha em bloqueios.log', async (t) => {
  t.mock.method(console, 'warn', () => {});
  lm.registrarBloqueio('8.8.8.8', 'IP não autorizado -> GET /');
  lm.registrarBloqueio('8.8.8.8', 'IP não autorizado -> GET /'); // sem dedup
  await esperaEscrita();
  const linhas = linhasDe('bloqueios.log');
  assert.strictEqual(linhas.length, 2);
  assert.match(linhas[0], / - 8\.8\.8\.8 - IP não autorizado -> GET \/$/);
});

test('console recebe a cor certa por categoria (FORCE_COLOR)', (t) => {
  process.env.FORCE_COLOR = '1';
  delete process.env.NO_COLOR;
  const capturado = { log: [], error: [], warn: [] };
  t.mock.method(console, 'log', (m) => capturado.log.push(m));
  t.mock.method(console, 'error', (m) => capturado.error.push(m));
  t.mock.method(console, 'warn', (m) => capturado.warn.push(m));

  const lm2 = new LogManager({ logsDir: dir }); // dedup zerado
  lm2.registrarConexao('10.9.9.9');
  lm2.registrarChamada('10.9.9.9', 'catálogo');
  lm2.registrarErro('teste', 'x');
  lm2.registrarBloqueio('10.9.9.9', 'x');

  assert.ok(capturado.log[0].startsWith('\x1b[94m'), 'conexão em azul');
  assert.ok(capturado.log[1].startsWith('\x1b[32m'), 'chamada em verde');
  assert.ok(capturado.error[0].startsWith('\x1b[31m'), 'erro em vermelho');
  assert.ok(capturado.warn[0].startsWith('\x1b[33m'), 'bloqueio em amarelo');
  delete process.env.FORCE_COLOR;
});
