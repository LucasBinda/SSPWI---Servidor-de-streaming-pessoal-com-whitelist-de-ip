const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { emitirToken, verificarToken, VIDA_MAXIMA_DIAS } = require('../lib/sessionToken');
const { SESSION_SECRET_PATH } = require('../lib/paths');

// Assina um payload igual ao sessionToken faz internamente — usado só pra
// forjar tokens de teste com exp/criadoEm controlados (o segredo é o mesmo
// que o módulo usa, lido de data/session-secret gerado no require acima).
function tokenForjado(dados) {
  const secret = fs.readFileSync(SESSION_SECRET_PATH, 'utf-8').trim();
  const payload = Buffer.from(JSON.stringify(dados)).toString('base64url');
  const assinatura = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${assinatura}`;
}

test('emitir + verificar: round-trip válido com uid', () => {
  const { token, uid } = emitirToken();
  const r = verificarToken(token);
  assert.strictEqual(r.valido, true);
  assert.strictEqual(r.dados.uid, uid);
});

test('renovação preserva uid e criadoEm', () => {
  const primeiro = verificarToken(emitirToken().token).dados;
  const renovado = verificarToken(emitirToken(primeiro).token).dados;
  assert.strictEqual(renovado.uid, primeiro.uid);
  assert.strictEqual(renovado.criadoEm, primeiro.criadoEm);
});

test('sem cookie -> inválido', () => {
  assert.strictEqual(verificarToken(undefined).valido, false);
  assert.strictEqual(verificarToken('').valido, false);
});

test('token malformado (sem ponto) -> inválido', () => {
  assert.strictEqual(verificarToken('semponto').valido, false);
});

test('assinatura adulterada -> inválido', () => {
  const { token } = emitirToken();
  const [payload] = token.split('.');
  const adulterado = `${payload}.assinaturafalsa`;
  assert.strictEqual(verificarToken(adulterado).valido, false);
});

test('payload adulterado (assinatura não bate) -> inválido', () => {
  const { token } = emitirToken();
  const [, assinatura] = token.split('.');
  const outroPayload = Buffer.from(JSON.stringify({ uid: 'invasor', criadoEm: Date.now(), exp: Date.now() + 1e9 })).toString('base64url');
  assert.strictEqual(verificarToken(`${outroPayload}.${assinatura}`).valido, false);
});

test('token expirado (exp no passado, mas bem assinado) -> inválido', () => {
  const agora = Date.now();
  const token = tokenForjado({ uid: 'x', criadoEm: agora - 1000, exp: agora - 1 });
  const r = verificarToken(token);
  assert.strictEqual(r.valido, false);
  assert.match(r.motivo, /expirado/);
});

test('login além do teto de vida máxima -> inválido mesmo com exp futuro', () => {
  const agora = Date.now();
  const criadoAntigo = agora - (VIDA_MAXIMA_DIAS + 1) * 24 * 60 * 60 * 1000;
  const token = tokenForjado({ uid: 'x', criadoEm: criadoAntigo, exp: agora + 1e9 });
  assert.strictEqual(verificarToken(token).valido, false);
});

test('token sem uid -> inválido', () => {
  const agora = Date.now();
  const token = tokenForjado({ criadoEm: agora, exp: agora + 1e9 });
  assert.strictEqual(verificarToken(token).valido, false);
});
