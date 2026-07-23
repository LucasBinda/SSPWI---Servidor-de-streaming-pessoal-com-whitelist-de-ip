const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadSettings } = require('./settings');
const { probeTracks, probeFile, forgetVideo } = require('./mediaTools');
const { coverPicker } = require('./coverPicker');
const { renomearArquivo } = require('./userStore');
const { lerJson, salvarJson } = require('./jsonStore');
const { logManager } = require('./logManager');
const reencodeStore = require('./stores/reencodeStore');

// Fase 2 — Padronização e Otimização de Armazenamento.
//
// Worker de background que converte pra .mp4 qualquer vídeo do acervo que
// não esteja nesse formato (MKV, AVI, etc.), substituindo o arquivo
// original DEPOIS de verificar que a conversão deu certo. Decisões de
// arquitetura (ver também docs/worker-reencode.md):
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

const {
  MOVIES_DIR,
  CATALOG_PATH,
  REENCODE_WORK_DIR: WORK_DIR,
} = require('./paths');

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

// O estado do worker (reencode-state.json) mora no store dedicado
// lib/stores/reencodeStore.js (um FileMirrorStore, chaveado pelo caminho do
// vídeo). lerEstado/salvarEstado só delegam a ele — é o dono único do arquivo e
// já se registra sozinho na varredura global.
function lerEstado() {
  return reencodeStore.carregar();
}

// Mantém o try/catch que loga sem derrubar o job em erro de disco.
function salvarEstado(estado) {
  try {
    reencodeStore.salvar(estado);
  } catch (err) {
    logManager.registrarErro('reencode', `falha ao salvar estado: ${err.message}`);
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

  if (enfileirou) logManager.info('reencode', `fila atual: ${fila.length} arquivo(s) não-mp4`);
  processarProximo();
}

function processarProximo() {
  if (processando || fila.length === 0) return;
  processando = true;
  const rel = fila.shift();

  processar(rel)
    .catch((err) => {
      logManager.registrarErro('reencode', `erro inesperado em ${rel}: ${err.message}`);
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
    logManager.aviso('reencode', `pulando ${rel}: destino já existe`);
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
      logManager.aviso('reencode', `pulando ${rel}: espaço em disco insuficiente`);
      return;
    }
  } catch {
    // statfs indisponível na plataforma — segue sem a checagem.
  }

  marcar(rel, 'processing');
  const tracks = await probeTracks(origem);
  const settings = loadSettings();

  // Precisando de re-encode de verdade (fora do caminho copy), a prova de
  // velocidade decide se ele roda no CPU ou na GPU.
  const codecOrigem = (tracks.video[0] && tracks.video[0].codec) || '';
  let modo = 'software';
  if (!VIDEO_CODECS_MODERNOS.has(codecOrigem)) {
    modo = await escolherModo(origem, codecOrigem, tracks.duracao, settings, rel);
  }

  fs.mkdirSync(WORK_DIR, { recursive: true });
  const tmpPath = path.join(WORK_DIR, `job-${Date.now()}.mp4`);

  const { args, resumo } = montarArgsFfmpeg(origem, tmpPath, tracks, settings, modo);
  logManager.info('reencode', `iniciando ${rel} (${resumo})`);

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
  logManager.info('reencode', `concluído ${relDestino}: ${(tamanhoOriginal / 1e6).toFixed(0)}MB -> ${(tamanhoNovo / 1e6).toFixed(0)}MB em ${minutos}min`);
}

// Codecs que o NVDEC (decoder de hardware das GPUs NVIDIA) sabe decodificar.
// Com o encoder hevc_nvenc, decodificar a origem na GPU também tira o CPU
// de praticamente todo o caminho da conversão.
const NVDEC_CODECS = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg2video', 'mpeg4', 'vc1']);

// Presets no vocabulário do x264/x265 -> equivalente aproximado do NVENC
// (p1 = mais rápido ... p7 = melhor compressão). Quem configurar p1-p7
// direto no settings.json passa reto, sem tradução.
function presetNvenc(preset) {
  if (/^p[1-7]$/.test(preset)) return preset;
  const mapa = {
    ultrafast: 'p1',
    superfast: 'p2',
    veryfast: 'p3',
    faster: 'p4',
    fast: 'p4',
    medium: 'p5',
    slow: 'p6',
    slower: 'p7',
    veryslow: 'p7',
  };
  return mapa[preset] || 'p5';
}

// Argumentos de vídeo de cada modo candidato de conversão. "software"
// respeita reencodeCodec/preset/crf do settings; os modos nvenc usam o
// encoder de hardware das GPUs NVIDIA (e o "nvenc+nvdec" também decodifica
// na GPU — CPU fora do caminho por completo). O NVENC não fala -crf nem os
// presets do x26x: a qualidade é o -cq (mesma escala) em modo vbr, com
// -b:v 0 pra não impor teto de bitrate — o cq manda sozinho.
function argsVideoDoModo(modo, settings) {
  if (modo === 'nvenc' || modo === 'nvenc+nvdec') {
    return {
      hwaccel: modo === 'nvenc+nvdec' ? ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'] : [],
      video: ['-c:v', 'hevc_nvenc', '-preset', presetNvenc(settings.reencodePreset), '-rc', 'vbr', '-cq', String(settings.reencodeCrf), '-b:v', '0'],
      rotulo: `${modo} (GPU) cq ${settings.reencodeCrf}`,
      saidaHevc: true,
    };
  }
  return {
    hwaccel: [],
    video: ['-c:v', settings.reencodeCodec, '-preset', settings.reencodePreset, '-crf', String(settings.reencodeCrf)],
    rotulo: `${settings.reencodeCodec} (CPU) crf ${settings.reencodeCrf}`,
    saidaHevc: settings.reencodeCodec === 'libx265',
  };
}

const PROVA_MS = 30 * 1000;

// Prova de velocidade: antes de um re-encode de verdade, cada modo converte
// a MESMA origem por até 30 segundos (ou até 50% do filme, o que vier
// primeiro), com a saída descartada — só interessa a velocidade média que
// cada um sustentou. O mais rápido faz a conversão completa. Modo que falha
// (máquina sem GPU NVIDIA, codec sem NVDEC...) sai da disputa com nota
// zero: a prova também é a detecção automática de hardware, sem nenhuma
// chave de configuração nova.
//
// Os candidatos de GPU (nvenc) rodam PRIMEIRO de propósito: numa máquina sem
// NVIDIA eles falham em menos de 1 segundo cada — aí não há por que gastar os
// 30s da prova do software, que é a única opção restante. Só quando alguma
// GPU responde é que vale provar o software também, pra comparar de verdade.
async function escolherModo(origem, codecOrigem, duracaoSegundos, settings, rel) {
  const provar = async (modo) => {
    const m = argsVideoDoModo(modo, settings);
    const argsProva = [
      '-y', '-nostats', '-loglevel', 'error',
      ...m.hwaccel, '-i', origem, '-map', '0:v:0', ...m.video,
      '-an', '-sn', '-progress', 'pipe:1', '-f', 'null', '-',
    ];
    return { modo, ...(await rodarProva(argsProva, duracaoSegundos)) };
  };

  const candidatosGpu = ['nvenc'];
  if (NVDEC_CODECS.has(codecOrigem)) candidatosGpu.push('nvenc+nvdec');

  const notas = [];
  for (const modo of candidatosGpu) notas.push(await provar(modo));

  const gpuFuncionou = notas.some((n) => !n.erro && n.velocidade > 0);
  if (!gpuFuncionou) {
    // Nenhuma GPU utilizável -> software é o único caminho possível; não há o
    // que comparar, então pulamos os 30s de prova dele e vamos direto.
    logManager.info('reencode', `prova de velocidade de ${rel}: ${resumoProva(notas)} -> software (sem GPU, prova pulada)`);
    return 'software';
  }

  // GPU respondeu: prova o software também pra escolher o mais rápido.
  notas.push(await provar('software'));

  const validas = notas.filter((n) => !n.erro && n.velocidade > 0);
  const vencedor = validas.reduce((a, b) => (b.velocidade > a.velocidade ? b : a));
  logManager.info('reencode', `prova de velocidade de ${rel}: ${resumoProva(notas)} -> ${vencedor.modo}`);
  return vencedor.modo;
}

function resumoProva(notas) {
  return notas.map((n) => `${n.modo} ${n.erro ? 'falhou' : `${n.velocidade.toFixed(1)}x`}`).join(', ');
}

// Um candidato da prova: roda por até PROVA_MS (ou 50% do filme) e mede a
// velocidade média (segundos de filme convertidos por segundo de relógio).
function rodarProva(argsProva, duracaoSegundos) {
  return new Promise((resolve) => {
    const comNice = process.platform !== 'win32';
    const cmd = comNice ? 'nice' : 'ffmpeg';
    const cmdArgs = comNice ? ['-n', '19', 'ffmpeg', ...argsProva] : argsProva;

    const proc = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    procAtual = proc;

    const inicio = Date.now();
    let stderrTail = '';
    let alcancouS = 0;
    let encerradoPorNos = false;

    const encerrar = () => {
      if (encerradoPorNos) return;
      encerradoPorNos = true;
      // SIGKILL sem cerimônia: a saída é descartada (-f null), não há
      // arquivo a finalizar — e SIGTERM o ffmpeg às vezes demora a honrar.
      if (proc.exitCode === null) proc.kill('SIGKILL');
    };
    const timer = setTimeout(encerrar, PROVA_MS);

    proc.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-1000);
    });

    let buffer = '';
    proc.stdout.on('data', (chunk) => {
      buffer = (buffer + chunk.toString()).slice(-2000);
      const tempos = buffer.match(/out_time_us=(\d+)/g);
      if (!tempos) return;
      alcancouS = Number(tempos[tempos.length - 1].slice('out_time_us='.length)) / 1e6;
      // Metade do filme convertida ainda na prova: já provou o bastante.
      if (duracaoSegundos > 0 && alcancouS >= duracaoSegundos / 2) encerrar();
    });

    proc.on('error', () => {
      clearTimeout(timer);
      procAtual = null;
      resolve({ velocidade: 0, erro: `${cmd} não iniciou` });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      procAtual = null;
      // Saída não-zero que NÃO fomos nós que provocamos: o modo quebraria
      // também na conversão completa — está fora da disputa.
      if (!encerradoPorNos && code !== 0) {
        return resolve({ velocidade: 0, erro: stderrTail.trim().slice(-200) || `ffmpeg saiu com código ${code}` });
      }
      const decorridoS = (Date.now() - inicio) / 1000;
      resolve({ velocidade: decorridoS > 0 ? alcancouS / decorridoS : 0 });
    });
  });
}

function montarArgsFfmpeg(origem, tmpPath, tracks, settings, modo) {
  const codecOrigem = (tracks.video[0] && tracks.video[0].codec) || '';
  const args = ['-y', '-nostats', '-loglevel', 'error'];
  const partesResumo = [];
  let saidaHevc;

  if (VIDEO_CODECS_MODERNOS.has(codecOrigem)) {
    args.push('-i', origem, '-map', '0:v:0', '-c:v', 'copy');
    partesResumo.push(`vídeo ${codecOrigem}: copy`);
    saidaHevc = codecOrigem === 'hevc';
  } else {
    const m = argsVideoDoModo(modo, settings);
    args.push(...m.hwaccel, '-i', origem, '-map', '0:v:0', ...m.video);
    partesResumo.push(`vídeo ${codecOrigem || '?'} -> ${m.rotulo}`);
    saidaHevc = m.saidaHevc;
  }

  // hvc1 é a tag que Safari/Apple exigem pra reconhecer HEVC dentro de mp4
  // (o padrão do ffmpeg, hev1, não toca lá). Vale pro copy de fonte hevc e
  // pros re-encodes que produzem HEVC (libx265 e hevc_nvenc).
  if (saidaHevc) {
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
    logManager.aviso('reencode', `${path.basename(origem)}: ${subsImagem} legenda(s) de imagem (PGS/VobSub) não cabem em mp4 e serão descartadas`);
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

// Segundos -> "38s" / "47min" / "2h05min", pro log de progresso ficar legível.
function formatarDuracao(segundos) {
  if (!isFinite(segundos) || segundos < 0) return '?';
  if (segundos < 60) return `${Math.round(segundos)}s`;
  const minutos = Math.round(segundos / 60);
  if (minutos < 60) return `${minutos}min`;
  return `${Math.floor(minutos / 60)}h${String(minutos % 60).padStart(2, '0')}min`;
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
    // pra acompanhar conversões longas sem inundar o log. Além do %, sai a
    // velocidade (1.0x = tempo real) e a estimativa de término — um encode
    // lento com nice -19 avança pouco por minuto e sem isso parece travado.
    let ultimoLog = Date.now();
    let bufferProgresso = '';
    proc.stdout.on('data', (chunk) => {
      bufferProgresso = (bufferProgresso + chunk.toString()).slice(-2000);
      if (Date.now() - ultimoLog < 60 * 1000) return;

      // O buffer guarda vários blocos de progresso — interessa o último
      // (mais recente) de cada campo.
      const tempos = bufferProgresso.match(/out_time_us=(\d+)/g);
      if (!tempos || duracaoSegundos <= 0) return;
      const outTimeS = Number(tempos[tempos.length - 1].slice('out_time_us='.length)) / 1e6;
      const pct = ((outTimeS / duracaoSegundos) * 100).toFixed(0);

      let extra = '';
      const velocidades = bufferProgresso.match(/speed=\s*([\d.]+)x/g);
      if (velocidades) {
        const speed = parseFloat(velocidades[velocidades.length - 1].replace('speed=', ''));
        if (speed > 0) {
          const restante = formatarDuracao((duracaoSegundos - outTimeS) / speed);
          extra = `, ${speed.toFixed(2)}x, faltam ~${restante}`;
        }
      }

      logManager.info('reencode', `${rel}: ~${pct}%${extra}`);
      ultimoLog = Date.now();
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
  const lista = lerJson(CATALOG_PATH, null);
  if (!Array.isArray(lista)) return;

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
    salvarJson(CATALOG_PATH, lista);
    logManager.info('reencode', `catálogo atualizado: ${relAntigo} -> ${relNovo}`);
  } catch (err) {
    logManager.registrarErro('reencode', `falha ao atualizar catálogo: ${err.message}`);
  }
}

module.exports = { prepararWorker, enfileirarNaoMp4 };
