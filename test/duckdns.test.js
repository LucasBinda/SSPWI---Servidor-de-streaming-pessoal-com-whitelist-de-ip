const { test } = require('node:test');
const assert = require('node:assert');
const { normalizarDominio, montarUrlAtualizacao } = require('../lib/duckdns');

// Só as funções puras — a chamada de rede real (atualizarDuckdns) não entra
// em teste unitário (depende do duckdns.org e de um token de verdade).

test('normalizarDominio: aceita com e sem o sufixo .duckdns.org', () => {
  assert.strictEqual(normalizarDominio('seucinema'), 'seucinema');
  assert.strictEqual(normalizarDominio('seucinema.duckdns.org'), 'seucinema');
});

test('normalizarDominio: apara espaços e baixa a caixa', () => {
  assert.strictEqual(normalizarDominio('  SeuCinema.DuckDNS.org '), 'seucinema');
});

test('normalizarDominio: vazio/nulo viram string vazia', () => {
  assert.strictEqual(normalizarDominio(''), '');
  assert.strictEqual(normalizarDominio(null), '');
  assert.strictEqual(normalizarDominio(undefined), '');
});

test('montarUrlAtualizacao: parâmetros obrigatórios da API', () => {
  const url = new URL(montarUrlAtualizacao('seucinema.duckdns.org', 'tok123', null));
  assert.strictEqual(url.origin + url.pathname, 'https://www.duckdns.org/update');
  assert.strictEqual(url.searchParams.get('domains'), 'seucinema'); // sem sufixo
  assert.strictEqual(url.searchParams.get('token'), 'tok123');
  assert.strictEqual(url.searchParams.get('ip'), ''); // vazio = autodetecção
  assert.strictEqual(url.searchParams.get('verbose'), 'true');
});

test('montarUrlAtualizacao: ipv6 entra só quando existe', () => {
  const sem = new URL(montarUrlAtualizacao('a', 't', null));
  assert.strictEqual(sem.searchParams.has('ipv6'), false);

  const com = new URL(montarUrlAtualizacao('a', 't', '2804:14d::1'));
  assert.strictEqual(com.searchParams.get('ipv6'), '2804:14d::1');
});

test('montarUrlAtualizacao: token com caracteres especiais é escapado', () => {
  const url = new URL(montarUrlAtualizacao('a', 'to&k=en 123', null));
  assert.strictEqual(url.searchParams.get('token'), 'to&k=en 123');
});
