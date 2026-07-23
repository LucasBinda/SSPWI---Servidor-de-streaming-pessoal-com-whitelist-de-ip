const { Store } = require('./index');
const { scanMoviesDir, sincronizarCatalogo } = require('../catalog');

// O catálogo (data/catalog.json) entra na varredura global de limpeza como um
// Store. A "poda" dele não é apagar chaves vencidas: é RE-SINCRONIZAR com o
// disco — remover entradas de filmes que não existem mais em media/movies/ e,
// junto, a capa gerada e o cache de legenda/ffprobe órfãos (tudo dentro de
// sincronizarCatalogo). Sem isso, um vídeo apagado direto do disco (sem ninguém
// abrir a página) só sumiria do catalog.json no próximo boot; agora some também
// na varredura de 6h. Como a travessia é própria (varre o DISCO, não só o JSON
// já carregado), estende Store direto e sobrescreve podarEPersistir em vez de
// usar o template de FileStore.
//
// Mora em arquivo próprio, mas depende da lógica de domínio do catálogo
// (scanMoviesDir/sincronizarCatalogo, exportadas por lib/catalog.js).
class CatalogStore extends Store {
  constructor() {
    super('catálogo');
  }

  podarEPersistir() {
    // sincronizarCatalogo só grava quando há mudança e loga o que removeu.
    sincronizarCatalogo(scanMoviesDir());
  }
}

// O require deste módulo (feito por lib/stores/index.js) já registra o store
// na varredura global (server.js: Store.podarTodas).
new CatalogStore();
