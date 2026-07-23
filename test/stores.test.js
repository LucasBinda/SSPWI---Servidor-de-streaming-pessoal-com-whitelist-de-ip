const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, FileStore, RetentionStore, FileMirrorStore } = require('../lib/stores');

// Arquivo temporário isolado por teste (nada toca os dados reais do projeto).
const tmp = () => path.join(os.tmpdir(), `store-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

test('Store é abstrata: não instancia direto', () => {
  assert.throws(() => new Store('x'), /abstrata/);
});

test('registro estático + podarTodas varre todos e blinda erro de um', () => {
  let podouA = false;
  let podouB = false;
  class A extends Store { podarEPersistir() { podouA = true; } }
  class B extends Store { podarEPersistir() { podouB = true; throw new Error('falha proposital'); } }

  // require('../lib/stores') já registra os stores reais (reencode, catálogo).
  // Isolamos o registro durante o teste pra (1) checar o count sem depender
  // deles e (2) NÃO disparar a poda nos dados reais ao chamar podarTodas.
  const reais = Store.registradas.splice(0, Store.registradas.length);
  try {
    new A('a');
    new B('b');
    assert.strictEqual(Store.registradas.length, 2);
    // O erro de B NÃO pode abortar a varredura nem propagar.
    assert.doesNotThrow(() => Store.podarTodas());
    assert.ok(podouA && podouB, 'ambos os stores foram varridos apesar do erro de um');
  } finally {
    Store.registradas.length = 0;
    Store.registradas.push(...reais);
  }
});

test('FileStore.podarEPersistir só grava quando a poda muda algo', () => {
  const caminho = tmp();
  fs.writeFileSync(caminho, JSON.stringify({ a: 1, b: 5 }));
  let gravou = 0;
  class T extends FileStore {
    constructor() { super('t', caminho, { padrao: {}, validar: (d) => !!d }); }
    podar(dados) { for (const k of Object.keys(dados)) if (dados[k] > 1) delete dados[k]; }
    salvar(dados) { gravou++; super.salvar(dados); }
  }
  const t = new T();
  t.podarEPersistir(); // remove b:5 -> mudou -> grava
  t.podarEPersistir(); // nada a remover -> NÃO grava de novo
  assert.strictEqual(gravou, 1, 'gravou uma vez só (save-if-changed)');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(caminho, 'utf-8')), { a: 1 });
  fs.rmSync(caminho, { force: true });
});

test('RetentionStore.vivoEm respeita a janela', () => {
  class R extends RetentionStore { podar() {} }
  const r = new R('r', tmp(), { padrao: {}, validar: (d) => !!d, janelaMs: 1000 });
  assert.ok(r.vivoEm(Date.now()), 'carimbo de agora está vivo');
  assert.ok(!r.vivoEm(Date.now() - 5000), 'carimbo além da janela está morto');
  assert.ok(!r.vivoEm('nao-numero'), 'valor inválido não conta como vivo');
});

test('FileMirrorStore remove entradas cujo arquivo-fonte sumiu', () => {
  const presente = tmp();
  fs.writeFileSync(presente, 'x');            // fonte existe
  const sumido = tmp();                        // fonte NÃO existe
  const estadoPath = tmp();
  fs.writeFileSync(estadoPath, JSON.stringify({ arquivos: { [presente]: { s: 1 }, [sumido]: { s: 2 } } }));

  class A extends FileMirrorStore {
    constructor() { super('a', estadoPath, { padrao: { arquivos: {} }, validar: (e) => e && e.arquivos }); }
    existe(chave) { return fs.existsSync(chave); }
    entradas(dados) { return dados.arquivos; }
  }
  new A().podarEPersistir();

  const depois = JSON.parse(fs.readFileSync(estadoPath, 'utf-8'));
  assert.ok(depois.arquivos[presente], 'entrada com arquivo presente permanece');
  assert.ok(!depois.arquivos[sumido], 'entrada com arquivo ausente é removida');
  fs.rmSync(presente, { force: true });
  fs.rmSync(estadoPath, { force: true });
});

test('métodos abstratos estouram se a subclasse não implementa', () => {
  class SemPodar extends FileStore {
    constructor() { super('sp', tmp(), { padrao: {}, validar: (d) => !!d }); }
  }
  assert.throws(() => new SemPodar().podar({}), /precisa implementar podar/);

  class SemExiste extends FileMirrorStore {
    constructor() { super('se', tmp(), { padrao: { arquivos: {} }, validar: (e) => !!e }); }
    entradas(d) { return d.arquivos; }
  }
  assert.throws(() => new SemExiste().existe('k'), /precisa implementar existe/);
});
