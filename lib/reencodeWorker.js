const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadSettings } = require('./settings');
const { probeTracks, probeFile, forgetVideo } = require('./mediaTools');
const { coverPicker } = require('./coverPicker');
const { renomearArquivo } = require('./watchTime');

// Fase 2 — Padronização e Otimização de Armazenamento.
//
// Worker de background que converte pra .mp4 qualquer vídeo do acervo que
// não esteja nesse formato (MKV, AVI, etc.), substituindo o arquivo
// original DEPOIS de verificar que a conversão deu certo. Decisões de
// arquitetura (ver também docs/fase2-worker-reencode.md):
//
// - UMA conversão por vez (fila serial): re-encode de vídeo é a operação
//   mais pesada que este servidor executa; duas em paralelo brigariam por
//   CPU entre si e com o streaming.
// - ffmpeg roda com `nice -n 19` (menor prioridade possível no Linux):
//   quem estiver ASSISTINDO alguma coisa nunca disputa CPU com o worker —
//   o encode usa só a sobra.
// - Copy quando dá, re-encode só quando precisa: se o vídeo original já é
//   HEVC/AV1, o stream é COPIADO pro .mp4 (remux: segundos, sem perda
//   nenhuma). Só vídeo em codec antigo (h264, mpeg4, vp9...) é re-encodado
//   pro codec alvo (libx265 por padrão). Mesma lógica pro áudio: AAC é
//   copiado; qualquer outro codec (AC3, DTS...) vira AAC, porque navegador
//   não decodifica AC3/DTS.
// - O original só é apagado depois que o .mp4 novo existe, foi sondado pelo
//   ffprobe e tem a duração esperada. Se qualquer passo falhar, o original
//   fica intocado e o job é marcado como "failed" (sem retry automático —
//   apague a entrada de data/reencode-state.json pra tentar de novo).
// - Estado persistido em data/reencode-state.json: sobrevive a restart do
//   servidor; jobs que estavam "processing" num crash voltam pra fila.

const MOVIES_DIR = path.join(__dirname, '..', 'media', 'movies');
const CATALOG_PATH = path.join(__dirname, '..', 'data', 'catalog.json');
const STATE_PATH = path.join(__dirname, '..', 'data', 'reencode-state.json');
const WORK_DIR = path.join(__dirname, '..', 'cache', 'reencode');

// Codecs de vídeo já "modernos e eficientes" — presença de um destes
// significa que basta remuxar (copy), sem re-encodar.
const VIDEO_CODECS_MODERNOS = new Set(['hevc', 'av1']);

// Codecs de legenda baseados em TEXTO, que o container mp4 aceita como
// mov_text. Legendas de IMAGEM (PGS de Bluray, VobSub de DVD) não têm
// equivalente em mp4 — são puladas com aviso no log.
const SUB_CODECS_TEXTO = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

// Tags de idioma que identificam áudio em português — usado pra marcar a
// dublagem como faixa padrão do arquivo final (sem transcodificação em
// tempo real, a faixa padrão do container é a que o navegador toca).
const IDIOMAS_PT = new Set(['por', 'pt', 'pob', 'ptb', 'pb']);

let fila = [];
let processando = false;
let procAtual = null;

function lerEstado() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    const estado = JSON.parse(raw);
    if (!estado.arquivos || typeof estado.arquivos !== 'object') return { arquivos: {} };
    return estado;
  } catch {
    return { arquivos: {} };
  }
}

function salvarEstado(estado) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(estado, null, 2) + '\n', 'utf-8');
  } catch (err) {
    console.error('[reencode] falha ao salvar estado:', err.message);
  }
}

function marcar(relPath, status, detalhe = '') {
  const estado = lerEstado();
  estado.arquivos[relPath] = { status, detalhe, atualizadoEm: new Date().toISOString() };
  salvarEstado(estado);
}

// Chamado uma vez no boot do servidor, ANTES de enfileirar qualquer coisa:
// limpa temporários de conversões interrompidas por crash/restart e devolve
// pra fila jobs que ficaram travados em "processing".
function prepararWorker() {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });

  const estado = lerEstado();
  let mudou = false;
  for (const info of Object.values(estado.arquivos)) {
    if (info.status === 'processing') {
      info.status = 'pending';
      info.detalhe = 'retomado após restart do servidor';
      mudou = true;
    }
  }
  if (mudou) salvarEstado(estado);

  // O node não mata processos filhos sozinho ao encerrar — sem isso, um
  // Ctrl+C no servidor deixaria um ffmpeg órfão codificando por horas.
  const encerrar = (signal) => {
    if (procAtual && procAtual.exitCode === null) procAtual.kill('SIGTERM');
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', () => encerrar('SIGINT'));
  process.once('SIGTERM', () => encerrar('SIGTERM'));
}

// Ponto de entrada: recebe a lista de caminhos relativos escaneados de
// media/movies (a mesma que alimenta o catálogo) e enfileira o que não for
// .mp4. Idempotente e barato — pode ser chamado a cada /api/movies.
function enfileirarNaoMp4(relPaths) {
  const settings = loadSettings();
  if (!settings.reencodeAtivo) return;

  const estado = lerEstado();
  let enfileirou = false;

  for (const rel of relPaths) {
    if (path.extname(rel).toLowerCase() === '.mp4') continue;

    const info = estado.arquivos[rel];
    // "done" não deve reaparecer (o arquivo antigo foi apagado); "failed"
    // não re-tenta sozinho pra não ficar em loop queimando CPU numa
    // conversão que sempre falha. "processing" é o job atual.
    if (info && info.status !== 'pending') continue;
    if (fila.includes(rel)) continue;

    fila.push(rel);
    if (!info) marcar(rel, 'pending');
    enfileirou = true;
  }

  if (enfileirou) console.log(`[reencode] fila atual: ${fila.length} arquivo(s) não-mp4`);
  processarProximo();
}

function processarProximo() {
  if (processando || fila.length === 0) return;
  processando = true;
  const rel = fila.shift();

  processar(rel)
    .catch((err) => {
      console.error(`[reencode] erro inesperado em ${rel}:`, err.message);
      marcar(rel, 'failed', err.message);
    })
    .finally(() => {
      processando = false;
      processarProximo();
    });
}

async function processar(rel) {
  const origem = path.normalize(path.join(MOVIES_DIR, rel));
  if (!fs.existsSync(origem)) {
    // Arquivo sumiu entre o enfileiramento e agora (usuário removeu) —
    // não é erro, só esquece o job.
    const estado = lerEstado();
    delete estado.arquivos[rel];
    salvarEstado(estado);
    return;
  }

  const relDestino = rel.slice(0, -path.extname(rel).length) + '.mp4';
  const destino = path.normalize(path.join(MOVIES_DIR, relDestino));
  if (fs.existsSync(destino)) {
    marcar(rel, 'failed', `já existe um .mp4 com o mesmo nome (${relDestino}) — resolva manualmente`);
    console.warn(`[reencode] pulando ${rel}: destino já existe`);
    return;
  }

  const tamanhoOriginal = fs.statSync(origem).size;

  // Espaço livre: durante a conversão coexistem original + temporário.
  // Exigimos folga de 1.2x o tamanho do original (a saída típica é menor,
  // mas um remux copy fica praticamente do mesmo tamanho).
  try {
    const stat = fs.statfsSync(MOVIES_DIR);
    const livre = stat.bsize * stat.bavail;
    if (livre < tamanhoOriginal * 1.2) {
      marcar(rel, 'failed', `sem espaço em disco (livre: ${(livre / 1e9).toFixed(1)}GB, necessário: ~${(tamanhoOriginal * 1.2 / 1e9).toFixed(1)}GB)`);
      console.warn(`[reencode] pulando ${rel}: espaço em disco insuficiente`);
      return;
    }
  } catch {
    // statfs indisponível na plataforma — segue sem a checagem.
  }

  marcar(rel, 'processing');
  const tracks = await probeTracks(origem);
  const settings = loadSettings();

  fs.mkdirSync(WORK_DIR, { recursive: true });
  const tmpPath = path.join(WORK_DIR, `job-${Date.now()}.mp4`);

  const { args, resumo } = montarArgsFfmpeg(origem, tmpPath, tracks, settings);
  console.log(`[reencode] iniciando ${rel} (${resumo})`);

  const inicio = Date.now();
  await rodarFfmpeg(args, tracks.duracao, rel);

  // Verificação antes de tocar no original: o .mp4 novo precisa existir,
  // ser sondável e ter a duração esperada (tolerância de 2% ou 5s).
  const saida = await probeFile(tmpPath);
  const tolerancia = Math.max(5, tracks.duracao * 0.02);
  if (tracks.duracao > 0 && Math.abs(saida.duracao - tracks.duracao) > tolerancia) {
    fs.rmSync(tmpPath, { force: true });
    throw new Error(`duração da saída (${saida.duracao.toFixed(0)}s) diverge da original (${tracks.duracao.toFixed(0)}s) — original preservado`);
  }
  if (saida.video.length === 0 || (tracks.audio.length > 0 && saida.audio.length === 0)) {
    fs.rmSync(tmpPath, { force: true });
    throw new Error('saída sem stream de vídeo/áudio esperado — original preservado');
  }

  // Substituição: move o temporário pro lugar definitivo e SÓ ENTÃO apaga
  // o original. rename pode falhar com EXDEV se cache/ e media/ estiverem
  // em discos diferentes — nesse caso copia e remove.
  try {
    fs.renameSync(tmpPath, destino);
  } catch (err) {
    if (err.code === 'EXDEV') {
      fs.copyFileSync(tmpPath, destino);
      fs.rmSync(tmpPath, { force: true });
    } else {
      throw err;
    }
  }
  fs.rmSync(origem, { force: true });

  // Preserva título/descrição/capa: se o catálogo tinha uma entrada
  // apontando pro arquivo antigo, ela passa a apontar pro novo — senão o
  // sincronizarCatalogo removeria a entrada antiga e criaria um rascunho
  // novo em branco, perdendo o que o usuário preencheu.
  atualizarCatalogo(rel, relDestino);

  // Limpa metadados de ffprobe e legendas extraídas do arquivo antigo.
  forgetVideo(origem);

  const tamanhoNovo = fs.statSync(destino).size;
  const minutos = ((Date.now() - inicio) / 60000).toFixed(1);
  const economia = ((1 - tamanhoNovo / tamanhoOriginal) * 100).toFixed(0);
  marcar(rel, 'done', `virou ${relDestino} (${(tamanhoOriginal / 1e9).toFixed(2)}GB -> ${(tamanhoNovo / 1e9).toFixed(2)}GB, ${economia}% menor, ${minutos}min)`);
  console.log(`[reencode] concluído ${relDestino}: ${(tamanhoOriginal / 1e6).toFixed(0)}MB -> ${(tamanhoNovo / 1e6).toFixed(0)}MB em ${minutos}min`);
}

function montarArgsFfmpeg(origem, tmpPath, tracks, settings) {
  const args = ['-y', '-nostats', '-loglevel', 'error', '-i', origem, '-map', '0:v:0'];
  const partesResumo = [];

  const codecOrigem = (tracks.video[0] && tracks.video[0].codec) || '';
  if (VIDEO_CODECS_MODERNOS.has(codecOrigem)) {
    args.push('-c:v', 'copy');
    partesResumo.push(`vídeo ${codecOrigem}: copy`);
  } else {
    args.push('-c:v', settings.reencodeCodec, '-preset', settings.reencodePreset, '-crf', String(settings.reencodeCrf));
    partesResumo.push(`vídeo ${codecOrigem || '?'} -> ${settings.reencodeCodec} crf ${settings.reencodeCrf}`);
  }
  // hvc1 é a tag que Safari/Apple exigem pra reconhecer HEVC dentro de mp4
  // (o padrão do ffmpeg, hev1, não toca lá). Vale tanto pro copy de fonte
  // hevc quanto pro re-encode com libx265.
  if (codecOrigem === 'hevc' || settings.reencodeCodec === 'libx265') {
    args.push('-tag:v', 'hvc1');
  }

  if (tracks.audio.length > 0) {
    args.push('-map', '0:a');
    const tudoAac = tracks.audio.every((faixa) => faixa.codec === 'aac');
    if (tudoAac) {
      args.push('-c:a', 'copy');
      partesResumo.push('áudio aac: copy');
    } else {
      // 256k dá conta até de 5.1 sem inflar o arquivo; navegador nenhum
      // decodifica AC3/DTS, então re-encodar aqui é obrigatório.
      args.push('-c:a', 'aac', '-b:a', '256k');
      partesResumo.push(`áudio ${tracks.audio.map((faixa) => faixa.codec).join('/')} -> aac`);
    }

    // Se há mais de uma faixa e alguma é português, ela vira a padrão do
    // container — é essa que o <video> nativo toca.
    if (tracks.audio.length > 1) {
      const idxPt = tracks.audio.findIndex((faixa) => IDIOMAS_PT.has((faixa.idioma || '').toLowerCase()));
      if (idxPt >= 0) {
        tracks.audio.forEach((_faixa, i) => {
          args.push(`-disposition:a:${i}`, i === idxPt ? 'default' : '0');
        });
        partesResumo.push(`faixa pt (${idxPt}) como padrão`);
      }
    }
  }

  const subsTexto = tracks.subtitles.filter((sub) => SUB_CODECS_TEXTO.has(sub.codec));
  const subsImagem = tracks.subtitles.length - subsTexto.length;
  for (const sub of subsTexto) args.push('-map', `0:s:${sub.index}`);
  if (subsTexto.length > 0) args.push('-c:s', 'mov_text');
  if (subsImagem > 0) {
    console.warn(`[reencode] ${path.basename(origem)}: ${subsImagem} legenda(s) de imagem (PGS/VobSub) não cabem em mp4 e serão descartadas`);
  }

  // faststart: moov no começo do arquivo — o navegador consegue começar a
  // tocar e fazer seek imediatamente via range requests, sem baixar o fim
  // do arquivo primeiro. É o que faz o /stream funcionar redondo.
  args.push('-movflags', '+faststart');
  // Progresso legível por máquina no stdout (rodarFfmpeg usa pra logar %).
  args.push('-progress', 'pipe:1');
  args.push(tmpPath);

  return { args, resumo: partesResumo.join(', ') };
}

function rodarFfmpeg(args, duracaoSegundos, rel) {
  return new Promise((resolve, reject) => {
    // nice -n 19: prioridade mínima de CPU — o encode nunca disputa com o
    // streaming de quem está assistindo. Em plataforma sem `nice`
    // (Windows), roda o ffmpeg direto.
    const comNice = process.platform !== 'win32';
    const cmd = comNice ? 'nice' : 'ffmpeg';
    const cmdArgs = comNice ? ['-n', '19', 'ffmpeg', ...args] : args;

    const proc = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    procAtual = proc;

    let stderrTail = '';
    proc.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });

    // -progress pipe:1 emite blocos key=value; logamos no máximo 1x/min
    // pra acompanhar conversões longas sem inundar o log.
    let ultimoLog = Date.now();
    let bufferProgresso = '';
    proc.stdout.on('data', (chunk) => {
      bufferProgresso = (bufferProgresso + chunk.toString()).slice(-2000);
      if (Date.now() - ultimoLog < 60 * 1000) return;
      const match = bufferProgresso.match(/out_time_us=(\d+)[\s\S]*$/);
      if (match && duracaoSegundos > 0) {
        const pct = ((Number(match[1]) / 1e6 / duracaoSegundos) * 100).toFixed(0);
        console.log(`[reencode] ${rel}: ~${pct}%`);
        ultimoLog = Date.now();
      }
    });

    proc.on('error', (err) => {
      procAtual = null;
      reject(new Error(`falha ao iniciar ${cmd} (está instalado e no PATH?): ${err.message}`));
    });

    proc.on('close', (code) => {
      procAtual = null;
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg saiu com código ${code}: ${stderrTail.trim().slice(-500)}`));
    });
  });
}

function atualizarCatalogo(relAntigo, relNovo) {
  let lista;
  try {
    lista = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'));
    if (!Array.isArray(lista)) return;
  } catch {
    return;
  }

  const item = lista.find((entrada) => entrada.arquivo === relAntigo);
  if (!item) return;

  item.arquivo = relNovo;

  // A capa automática usa hash do caminho — renomear o arquivo mudaria o
  // hash e deixaria a capa antiga órfã. Move o jpg pro hash novo e, se a
  // entrada apontava pra URL antiga, atualiza junto.
  const capaAntiga = coverPicker.capaAutoUrl(relAntigo);
  const capaNova = coverPicker.moverCapa(relAntigo, relNovo);
  if (capaNova && item.capa === capaAntiga) item.capa = capaNova;

  // A minutagem salva dos usuários também acompanha o nome novo.
  renomearArquivo(relAntigo, relNovo);

  try {
    fs.writeFileSync(CATALOG_PATH, JSON.stringify(lista, null, 2) + '\n', 'utf-8');
    console.log(`[reencode] catálogo atualizado: ${relAntigo} -> ${relNovo}`);
  } catch (err) {
    console.error('[reencode] falha ao atualizar catálogo:', err.message);
  }
}

module.exports = { prepararWorker, enfileirarNaoMp4 };
