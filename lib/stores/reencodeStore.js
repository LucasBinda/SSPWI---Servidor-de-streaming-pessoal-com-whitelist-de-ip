const fs = require('fs');
const path = require('path');
const { MOVIES_DIR, REENCODE_STATE_PATH: STATE_PATH } = require('../paths');
const { FileMirrorStore } = require('./index');

// Estado do worker de re-encode (data/reencode-state.json) como um
// FileMirrorStore: cada entrada é chaveada pelo caminho do vídeo original.
// Quando esse arquivo some do disco, a entrada vira lixo — um job "done" cujo
// .mkv já foi trocado pelo .mp4, ou um "failed" de um vídeo que o usuário
// depois apagou. A superclasse remove essas entradas na varredura global do
// server.js. Antes, uma entrada "done"/"failed" só sumia se aquele job
// específico rodasse de novo — o que, pra "done", nunca acontece: o dado
// acumulava pra sempre.
//
// Fica em arquivo próprio (não dentro do reencodeWorker) porque só depende de
// paths + da classe-base; o worker consome a instância exportada aqui pra ler
// e gravar o estado (lerEstado/salvarEstado).
class ReencodeStore extends FileMirrorStore {
  constructor() {
    super('reencode', STATE_PATH, {
      padrao: { arquivos: {} },
      validar: (e) => e && typeof e === 'object' && e.arquivos && typeof e.arquivos === 'object',
    });
  }

  // A fonte de uma entrada é o vídeo original em media/movies/.
  existe(rel) {
    return fs.existsSync(path.normalize(path.join(MOVIES_DIR, rel)));
  }

  entradas(estado) {
    return estado.arquivos;
  }
}

// Instância única (o require já a registra na varredura). Exportada pro
// reencodeWorker usar como dono único do reencode-state.json.
module.exports = new ReencodeStore();
