const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LogManager, pintar } = require('../lib/logManager');
const { validarAntiFilterLog } = require('../lib/settings');
const { SETTINGS_PATH } = require('../lib/paths');

// Roda fn com o antiFilterLog do settings.json real ajustado, e SEMPRE
// restaura o arquivo depois (mesmo se a asserção falhar). valor === undefined
// remove a chave. As funções sob teste leem o arquivo, então precisamos dele.
async function comAntiFilterLog(valor, fn) {
  const backup = fs.readFileSync(SETTINGS_PATH, 'utf-8');
  try {
    const base = JSON.parse(backup);
    if (valor === undefined) delete base.antiFilterLog;
    else base.antiFilterLog = valor;
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(base, null, 2) + '\n');
    return await fn();
  } finally {
    fs.writeFileSync(SETTINGS_PATH, backup);
  }
}

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

test('registrarBloqueio: dedup por IP+motivo (o laço de reautorização vira 1 linha)', async (t) => {
  t.mock.method(console, 'warn', () => {});
  // mesmo IP+motivo repetido (o spam do laço) -> uma linha só
  lm.registrarBloqueio('8.8.8.8', 'sessão negada -> GET /api/movies');
  lm.registrarBloqueio('8.8.8.8', 'sessão negada -> GET /api/movies');
  lm.registrarBloqueio('8.8.8.8', 'sessão negada -> GET /api/movies');
  // motivo diferente = evento novo -> registra
  lm.registrarBloqueio('8.8.8.8', 'IP não autorizado -> GET /');
  // IP diferente, mesmo motivo = evento novo -> registra
  lm.registrarBloqueio('9.9.9.9', 'sessão negada -> GET /api/movies');
  await esperaEscrita();
  const linhas = linhasDe('bloqueios.log');
  assert.strictEqual(linhas.length, 3, 'o laço vira 1 linha; motivo/IP distintos registram');
  assert.match(linhas[0], / - 8\.8\.8\.8 - sessão negada -> GET \/api\/movies$/);
});

test('validarAntiFilterLog: true/false valem; ausente ou não-booleano -> false inválido', async () => {
  await comAntiFilterLog(true, () => assert.deepStrictEqual(validarAntiFilterLog(), { valor: true, valido: true }));
  await comAntiFilterLog(false, () => assert.deepStrictEqual(validarAntiFilterLog(), { valor: false, valido: true }));
  await comAntiFilterLog('yes', () => assert.deepStrictEqual(validarAntiFilterLog(), { valor: false, valido: false }));
  await comAntiFilterLog(1, () => assert.deepStrictEqual(validarAntiFilterLog(), { valor: false, valido: false }));
  await comAntiFilterLog(undefined, () => assert.deepStrictEqual(validarAntiFilterLog(), { valor: false, valido: false }));
});

test('antiFilterLog=true desliga o dedupe: 3 repetições viram 3 linhas', async (t) => {
  t.mock.method(console, 'warn', () => {});
  await comAntiFilterLog(true, async () => {
    const lm2 = new LogManager({ logsDir: dir }); // maps de dedup zerados
    for (let i = 0; i < 3; i++) lm2.registrarBloqueio('7.7.7.7', 'sessão negada -> GET /api/movies');
    await esperaEscrita();
    const linhas = linhasDe('bloqueios.log').filter((l) => l.includes('7.7.7.7'));
    assert.strictEqual(linhas.length, 3, 'sem dedupe, cada tentativa é uma linha');
  });
});

test('antiFilterLog=false mantém o dedupe (contraprova)', async (t) => {
  t.mock.method(console, 'warn', () => {});
  await comAntiFilterLog(false, async () => {
    const lm3 = new LogManager({ logsDir: dir });
    for (let i = 0; i < 3; i++) lm3.registrarBloqueio('6.6.6.6', 'sessão negada -> GET /api/movies');
    await esperaEscrita();
    const linhas = linhasDe('bloqueios.log').filter((l) => l.includes('6.6.6.6'));
    assert.strictEqual(linhas.length, 1, 'com dedupe, o laço vira 1 linha');
  });
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
