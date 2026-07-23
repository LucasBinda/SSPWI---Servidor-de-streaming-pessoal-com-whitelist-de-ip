const { lerJson, salvarJson } = require('../jsonStore');
const { logManager } = require('../logManager');

// Hierarquia de "stores" (os bancos JSON do projeto), no estilo superclasse do
// Java: uma classe-base abstrata concentra o que é comum e as concretas só
// preenchem o que é específico. O objetivo NÃO é reaproveitar código por
// vaidade — é fechar um buraco real: antes, cada store novo precisava que
// alguém LEMBRASSE de fiar a limpeza dele no server.js (podarOrfaos +
// podarAutoIpsExpirados listados à mão). Quem esquece deixa dado acumulando
// pra sempre. Aqui a limpeza é herdada e o registro é automático — store novo
// entra na varredura de graça, é impossível esquecer.
//
//   Store  ............... raiz abstrata: registro estático + podarTodas()
//    └─ FileStore  ....... dona de um arquivo JSON: I/O comum + template de poda
//        ├─ RetentionStore ..... poda por TEMPO (janela de retenção)
//        └─ FileMirrorStore .... poda quando o arquivo-fonte some do disco
//
// Os stores concretos vivem em arquivos separados; os desta pasta são
// carregados no fim deste módulo (veja o rodapé) pra que um único
// require('./stores') já registre todos na varredura.

// --- Raiz -----------------------------------------------------------------

class Store {
  // O registro que torna a poda impossível de esquecer: TODA instância se
  // inscreve aqui sozinha no construtor (veja abaixo). O server.js varre a
  // lista inteira com uma chamada só — Store.podarTodas() — no boot e a cada
  // 6h. Um store que estenda esta classe e seja `require`-ado já entra na
  // varredura; ninguém precisa tocar no server.js.
  static registradas = [];

  constructor(nome) {
    if (new.target === Store) {
      throw new Error('Store é abstrata: estenda-a, não instancie direto');
    }
    // Rótulo pros logs de limpeza ('user', 'whitelist', 'reencode'...).
    this.nome = nome;
    Store.registradas.push(this);
  }

  // Método abstrato (o Java teria `abstract`; no JS a gente estoura se a
  // subclasse não sobrescrever). Faz a limpeza do store e persiste se mudou.
  // NÃO deve lançar — limpeza é higiene de fundo, não pode derrubar o boot.
  podarEPersistir() {
    throw new Error(`${this.constructor.name} precisa implementar podarEPersistir()`);
  }

  // Varre TODOS os stores registrados. Blinda cada um num try/catch pra que
  // um store com defeito não aborte a limpeza dos outros.
  static podarTodas() {
    for (const store of Store.registradas) {
      try {
        store.podarEPersistir();
      } catch (err) {
        logManager.registrarErro(store.nome, `poda falhou: ${err.message}`);
      }
    }
  }
}

// --- Stores que são donos de um arquivo JSON inteiro ----------------------

// Concentra a I/O comum (ler/gravar o arquivo). Vale pra store que é dono do
// arquivo todo (data/users.json, reencode-state.json). A whitelist NÃO entra
// aqui: ela divide o arquivo com a lista manual e a leitura dela é fail-closed
// (lança de propósito) — ver AutoIpStore em middleware/ipWhitelist.js.
class FileStore extends Store {
  // @param padrao   valor devolvido quando o arquivo não existe/é inválido
  // @param validar  valida a forma lida (mesmo contrato do jsonStore)
  constructor(nome, caminho, { padrao, validar }) {
    super(nome);
    this.caminho = caminho;
    this._padrao = padrao;
    this._validar = validar;
  }

  // Clona o padrão a cada leitura pra ninguém mutar o default compartilhado.
  // Todo padrão daqui é JSON puro ({}, [], {arquivos:{}}), então o round-trip
  // é seguro e sem dependência.
  carregar() {
    return lerJson(this.caminho, JSON.parse(JSON.stringify(this._padrao)), this._validar);
  }

  salvar(dados) {
    salvarJson(this.caminho, dados);
  }

  // Template method: a subclasse implementa a poda do SEU formato, apagando
  // in-place o que venceu. Não precisa carregar nem salvar — isso é aqui.
  podar(dados) {
    throw new Error(`${this.constructor.name} precisa implementar podar(dados)`);
  }

  // Carrega -> poda -> só grava se algo mudou (evita reescrever o arquivo à
  // toa a cada 6h). Loga uma vez quando remove algo.
  podarEPersistir() {
    const dados = this.carregar();
    const antes = JSON.stringify(dados);
    this.podar(dados);
    if (JSON.stringify(dados) === antes) return;
    try {
      this.salvar(dados);
      logManager.info(this.nome, 'dados obsoletos removidos');
    } catch (err) {
      logManager.registrarErro(this.nome, `falha ao salvar após poda: ${err.message}`);
    }
  }
}

// --- Ramo 1: poda por TEMPO -----------------------------------------------

// Store cujos dados têm prazo de validade (login/cookie): passou da janela de
// retenção sem atividade, some. A subclasse implementa podar(dados) usando
// vivoEm() pra decidir o que fica. Ex.: UserStore (lib/userStore.js).
class RetentionStore extends FileStore {
  constructor(nome, caminho, { padrao, validar, janelaMs }) {
    super(nome, caminho, { padrao, validar });
    this.janelaMs = janelaMs;
  }

  // Um carimbo (ms) ainda está dentro da janela de retenção?
  vivoEm(carimboMs) {
    return typeof carimboMs === 'number' && carimboMs >= Date.now() - this.janelaMs;
  }
}

// --- Ramo 2: poda por ARQUIVO-FONTE ---------------------------------------

// Store cujas entradas espelham arquivos no disco: quando o arquivo-fonte
// some, a entrada vira lixo e deve sumir junto. A subclasse diz COMO achar as
// entradas e SE a fonte de cada chave ainda existe; a poda é herdada.
// Ex.: ReencodeStore (lib/stores/reencodeStore.js).
class FileMirrorStore extends FileStore {
  // Método abstrato: a fonte desta chave ainda está no disco?
  existe(chave) {
    throw new Error(`${this.constructor.name} precisa implementar existe(chave)`);
  }

  // Método abstrato: devolve o mapa { chave: registro } de dentro dos dados
  // carregados (o objeto que será podado in-place).
  entradas(dados) {
    throw new Error(`${this.constructor.name} precisa implementar entradas(dados)`);
  }

  podar(dados) {
    const mapa = this.entradas(dados);
    for (const chave of Object.keys(mapa)) {
      if (!this.existe(chave)) delete mapa[chave];
    }
  }
}

module.exports = { Store, FileStore, RetentionStore, FileMirrorStore };

// Carrega (e, ao carregar, registra) os stores concretos que moram nesta
// pasta. Fica DEPOIS do module.exports de propósito: assim, quando estes
// módulos derem require('./index') pra pegar as classes-base, os exports já
// estão prontos (quebra o ciclo). Os stores que vivem junto da sua lógica de
// domínio (UserStore em lib/userStore.js, AutoIpStore em
// middleware/ipWhitelist.js) se registram quando os módulos deles carregam.
require('./reencodeStore');
require('./catalogStore');
