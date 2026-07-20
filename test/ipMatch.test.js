const { test } = require('node:test');
const assert = require('node:assert');
const { ipEstaAutorizado } = require('../middleware/ipMatch');

// ipEstaAutorizado(ip, lista): a lista aceita IP exato ou faixa CIDR, IPv4 e
// IPv6. É a base da whitelist — um falso positivo aqui é um furo de acesso.

test('IPv4 exato: casa e não casa', () => {
  assert.strictEqual(ipEstaAutorizado('192.168.0.10', ['192.168.0.10']), true);
  assert.strictEqual(ipEstaAutorizado('192.168.0.11', ['192.168.0.10']), false);
});

test('IPv4 CIDR /24', () => {
  const lista = ['192.168.0.0/24'];
  assert.strictEqual(ipEstaAutorizado('192.168.0.1', lista), true);
  assert.strictEqual(ipEstaAutorizado('192.168.0.254', lista), true);
  assert.strictEqual(ipEstaAutorizado('192.168.1.1', lista), false);
});

test('IPv4 CIDR /32 = só o próprio IP', () => {
  assert.strictEqual(ipEstaAutorizado('10.0.0.5', ['10.0.0.5/32']), true);
  assert.strictEqual(ipEstaAutorizado('10.0.0.6', ['10.0.0.5/32']), false);
});

test('CIDR /0 casa qualquer IPv4', () => {
  assert.strictEqual(ipEstaAutorizado('8.8.8.8', ['0.0.0.0/0']), true);
});

test('IPv6 exato', () => {
  assert.strictEqual(ipEstaAutorizado('2804:14d::1', ['2804:14d::1']), true);
  assert.strictEqual(ipEstaAutorizado('2804:14d::2', ['2804:14d::1']), false);
});

test('IPv6 CIDR /48', () => {
  const lista = ['2804:14d:ae86::/48'];
  assert.strictEqual(ipEstaAutorizado('2804:14d:ae86:8047:6e98::1', lista), true);
  assert.strictEqual(ipEstaAutorizado('2804:14d:ae87::1', lista), false);
});

test('IPv6 abreviado (::) casa forma expandida na mesma faixa', () => {
  assert.strictEqual(ipEstaAutorizado('2804:14d:ae86:0:0:0:0:1', ['2804:14d:ae86::/48']), true);
});

test('famílias trocadas não casam (v4 contra faixa v6 e vice-versa)', () => {
  assert.strictEqual(ipEstaAutorizado('192.168.0.1', ['2804:14d::/32']), false);
  assert.strictEqual(ipEstaAutorizado('2804:14d::1', ['192.168.0.0/24']), false);
});

test('lista vazia nunca autoriza', () => {
  assert.strictEqual(ipEstaAutorizado('127.0.0.1', []), false);
});

test('múltiplas entradas: casa se qualquer uma bater', () => {
  const lista = ['10.0.0.1', '192.168.0.0/24', '::1'];
  assert.strictEqual(ipEstaAutorizado('192.168.0.50', lista), true);
  assert.strictEqual(ipEstaAutorizado('::1', lista), true);
  assert.strictEqual(ipEstaAutorizado('172.16.0.1', lista), false);
});
