const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { probeTracks } = require('./mediaTools');
const { loadSettings } = require('./settings');

// Fase 4 — Aleatorizador de capas.
//
// Para todo filme SEM capa (ou com capa local referenciada que não existe
// mais em disco), extrai um frame aleatório do próprio vídeo — em algum
// ponto entre 20% e 80% da duração, evitando aberturas/créditos — e usa
// como imagem de capa no catálogo.
//
// Decisões:
// - Classe separada com uma instância compartilhada exportada: o estado da
//   fila (o que já está agendado) precisa ser único no processo, mas a
//   classe fica testável/reutilizável isolada.
// - Fila serial, mesmo raciocínio do reencodeWorker: extrair um frame é
//   rápido (~1s com input seeking), mas um acervo grande no primeiro boot
//   dispararia dezenas de ffmpeg simultâneos sem a fila.
// - Capas geradas ficam em media/covers/auto/<hash-do-caminho>.jpg — o
//   nome determinístico é o que permite apagar a capa certa quando o filme
//   é removido de media/movies/ (removerCapa) e mover quando o worker de
//   re-encode renomeia .mkv -> .mp4 (moverCapa).
// - Só capas LOCAIS (/covers/...) passam pela checagem de existência; capa
//   apontando pra URL externa (http...) é responsabilidade do usuário.
// - O caminho gerado é gravado em data/catalog.json (campo capa) — é o
//   mesmo campo que o usuário edita à mão, então a capa automática se
//   comporta como qualquer outra: trocável, e nunca sobrescrita depois que
//   existe (só regerada se o arquivo dela sumir).

class CoverPicker {
  constructor({ moviesDir, coversDir, catalogPath }) {
    this.moviesDir = moviesDir;
    this.coversDir = coversDir;
    this.autoDir = path.join(coversDir, 'auto');
    this.catalogPath = catalogPath;
    this.fila = [];
    this.processando = false;
    this.agendados = new Set();
    this.tmpVarrido = false;
  }

  // A troca de capa em si nunca deixa arquivo velho pra trás — o
  // renameSync em gerarCapa substitui o jpg antigo atomicamente (mesmo
  // nome, o conteúdo anterior é desvinculado pelo SO no ato). O único
  // resto possível é um ".tmp" órfão de uma geração interrompida por
  // crash/restart do servidor — esta varredura (uma vez por processo, na
  // primeira chamada) recolhe esses.
  varrerTmpOrfaos() {
    if (this.tmpVarrido) return;
    this.tmpVarrido = true;
    let nomes;
    try {
      nomes = fs.readdirSync(this.autoDir);
    } catch {
      return;
    }
    for (const nome of nomes) {
      if (nome.endsWith('.tmp')) {
        fs.rm(path.join(this.autoDir, nome), { force: true }, () => {});
      }
    }
  }

  hashDe(relPath) {
    return crypto.createHash('sha1').update(relPath).digest('hex').slice(0, 20);
  }

  // Caminho da capa automática nos dois "mundos": URL servida pela rota
  // /covers/ e caminho absoluto no disco.
  capaAutoUrl(relPath) {
    return `/covers/auto/${this.hashDe(relPath)}.jpg`;
  }

  capaAutoAbs(relPath) {
    return path.join(this.autoDir, `${this.hashDe(relPath)}.jpg`);
  }

  // Uma capa local ("/covers/...") existe em disco? URLs externas contam
  // como existentes (não há como checar barato — e são escolha do usuário).
  capaExiste(capa) {
    if (!capa) return false;
    if (!capa.startsWith('/covers/')) return true;
    const rel = capa.replace('/covers/', '');
    const abs = path.normalize(path.join(this.coversDir, rel));
    if (!abs.startsWith(this.coversDir + path.sep)) return false;
    return fs.existsSync(abs);
  }

  // Ponto de entrada: recebe as entradas do catálogo (arquivo + capa) e
  // agenda geração pra quem precisa. Chamado no boot e a cada /api/movies —
  // barato e idempotente (o Set de agendados evita duplicar trabalho).
  //
  // Com trocarCapasAutoNoCatalogo ligado em config/settings.json, capas
  // AUTOMÁTICAS existentes também entram na fila — cada chamada do
  // catálogo sorteia um frame novo. A comparação com capaAutoUrl garante
  // que capa definida à mão pelo usuário (URL diferente) nunca é trocada.
  garantirCapas(entradas) {
    this.varrerTmpOrfaos();
    const trocarAuto = loadSettings().trocarCapasAutoNoCatalogo === true;

    for (const entrada of entradas) {
      if (!entrada.arquivo) continue;
      const ehCapaAuto = entrada.capa === this.capaAutoUrl(entrada.arquivo);
      if (this.capaExiste(entrada.capa) && !(trocarAuto && ehCapaAuto)) continue;
      if (this.agendados.has(entrada.arquivo)) continue;

      const origem = path.normalize(path.join(this.moviesDir, entrada.arquivo));
      if (!fs.existsSync(origem)) continue;

      this.agendados.add(entrada.arquivo);
      this.fila.push(entrada.arquivo);
    }
    this.processarProxima();
  }

  processarProxima() {
    if (this.processando || this.fila.length === 0) return;
    this.processando = true;
    const rel = this.fila.shift();

    this.gerarCapa(rel)
      .then(() => {
        this.atualizarCatalogo(rel, this.capaAutoUrl(rel));
        console.log(`[capas] capa gerada para ${path.basename(rel)}`);
      })
      .catch((err) => {
        console.error(`[capas] falha ao gerar capa de ${rel}:`, err.message);
      })
      .finally(() => {
        // Sai de "agendados" nos dois desfechos: no sucesso a capa agora
        // existe (capaExiste passa a dar true); na falha, permitir novo
        // agendamento na próxima chamada dá a chance de recuperar de erros
        // transitórios sem loop apertado — a cadência é ditada por quem
        // chama (boot / aberturas do catálogo).
        this.agendados.delete(rel);
        this.processando = false;
        this.processarProxima();
      });
  }

  async gerarCapa(rel) {
    const origem = path.normalize(path.join(this.moviesDir, rel));
    const { duracao } = await probeTracks(origem);
    if (!duracao || duracao <= 0) throw new Error('duração desconhecida');

    // Ponto aleatório entre 20% e 80% do filme — longe de abertura escura
    // e de créditos finais.
    const posicao = duracao * (0.2 + Math.random() * 0.6);

    fs.mkdirSync(this.autoDir, { recursive: true });
    const destino = this.capaAutoAbs(rel);
    const tmp = `${destino}.${process.pid}.tmp`;

    // -ss ANTES do -i: input seeking (pula direto pro keyframe mais
    // próximo, ~instantâneo) em vez de decodificar o filme até o ponto.
    // -vf scale mantém a proporção limitando a largura — capa não precisa
    // de 1080p, e o jpg fica pequeno o suficiente pro grid do catálogo.
    const args = [
      '-y', '-loglevel', 'error',
      '-ss', posicao.toFixed(2),
      '-i', origem,
      '-frames:v', '1',
      '-vf', 'scale=480:-2',
      '-q:v', '3',
      '-f', 'image2',
      tmp,
    ];

    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (chunk) => { stderr += chunk; });
      proc.on('error', (err) => reject(new Error(`falha ao iniciar ffmpeg: ${err.message}`)));
      proc.on('close', (code) => {
        if (code !== 0) {
          fs.rm(tmp, { force: true }, () => {});
          return reject(new Error(`ffmpeg saiu com código ${code}: ${stderr.trim().slice(-300)}`));
        }
        resolve();
      });
    });

    fs.renameSync(tmp, destino);
  }

  atualizarCatalogo(rel, capaUrl) {
    let lista;
    try {
      lista = JSON.parse(fs.readFileSync(this.catalogPath, 'utf-8'));
      if (!Array.isArray(lista)) return;
    } catch {
      return;
    }

    const item = lista.find((entrada) => entrada.arquivo === rel);
    if (!item) return;
    // Não sobrescreve capa que o usuário definiu e que existe — só ocupa o
    // lugar se estava vazia ou apontando pra arquivo local sumido.
    if (this.capaExiste(item.capa)) return;

    item.capa = capaUrl;
    try {
      fs.writeFileSync(this.catalogPath, JSON.stringify(lista, null, 2) + '\n', 'utf-8');
    } catch (err) {
      console.error('[capas] falha ao atualizar catálogo:', err.message);
    }
  }

  // Chamado quando um filme é removido de media/movies/ (routes/movies.js,
  // junto do forgetVideo): a capa automática dele não pode ficar órfã.
  removerCapa(rel) {
    fs.rm(this.capaAutoAbs(rel), { force: true }, (err) => {
      if (err) console.error(`[capas] falha ao remover capa de ${rel}:`, err.message);
    });
  }

  // Chamado pelo worker de re-encode quando um arquivo é renomeado
  // (.mkv -> .mp4): o hash do caminho muda, então a capa automática antiga
  // é movida pro novo nome e a URL nova é devolvida pra atualizar o
  // catálogo. Sem capa antiga -> null (a capa nasce depois, no fluxo normal).
  moverCapa(relAntigo, relNovo) {
    const antigoAbs = this.capaAutoAbs(relAntigo);
    if (!fs.existsSync(antigoAbs)) return null;
    fs.mkdirSync(this.autoDir, { recursive: true });
    fs.renameSync(antigoAbs, this.capaAutoAbs(relNovo));
    return this.capaAutoUrl(relNovo);
  }
}

// Instância compartilhada do processo — todo mundo (rotas, worker, boot)
// enxerga a mesma fila e o mesmo estado de agendamento.
const coverPicker = new CoverPicker({
  moviesDir: path.join(__dirname, '..', 'media', 'movies'),
  coversDir: path.join(__dirname, '..', 'media', 'covers'),
  catalogPath: path.join(__dirname, '..', 'data', 'catalog.json'),
});

module.exports = { CoverPicker, coverPicker };
