const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runFfmpeg } = require('./ffmpeg');
const { logManager } = require('./logManager');

// Este módulo é o que SOBROU da reversão do HLS on-the-fly:
// só as operações de mídia baratas em CPU — sondar faixas com ffprobe e
// extrair legendas (WebVTT) e faixas de áudio (.m4a). A transcodificação
// de vídeo em tempo real (sessões de ffmpeg por playback) foi removida por
// pesar demais no processador do servidor; o vídeo volta a ser servido
// direto pelo /stream com range requests.

// Cache de legendas extraídas (WebVTT), organizado por PASTA por vídeo —
// não por arquivo achatado — de propósito: quando um filme é removido de
// media/movies/, limpar tudo que ele deixou em cache vira um único rm -rf
// dessa pasta (ver forgetVideo), sem precisar saber de antemão quais índices
// de legenda foram extraídos.
const { SUBS_CACHE_ROOT } = require('./paths');

// Cache em memória de metadados de faixas por arquivo, invalidado se o
// arquivo mudar de mtime (por exemplo depois de um re-encode da fase 2).
// Evita rodar o ffprobe de novo toda vez que o usuário abre o player.
const trackCache = new Map(); // videoPath -> { mtimeMs, tracks }

async function probeTracksRaw(videoPath) {
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    // format=duration junto dos streams: duração real do arquivo, usada
    // pelo front-end como fallback quando o <video> ainda não carregou
    // os metadados.
    '-show_entries', 'format=duration:stream=index,codec_type,codec_name,channels,pix_fmt:stream_tags=language,title:stream_disposition=default',
    '-i', videoPath,
  ];
  const { stdout } = await runFfmpeg(args, { bin: 'ffprobe', capturarStdout: true });

  const parsed = JSON.parse(stdout);
  const video = [];
  const audio = [];
  const subtitles = [];
  // ffmpeg indexa "-map 0:a:N" / "-map 0:s:N" relativo a cada TIPO de
  // faixa, não ao índice absoluto do stream no container — por isso
  // contamos audioIdx/subIdx separados em vez de usar stream.index.
  let audioIdx = 0;
  let subIdx = 0;
  for (const stream of parsed.streams || []) {
    const tags = stream.tags || {};
    if (stream.codec_type === 'video') {
      video.push({
        codec: stream.codec_name || '',
        pixFmt: stream.pix_fmt || '',
      });
    } else if (stream.codec_type === 'audio') {
      audio.push({
        index: audioIdx,
        codec: stream.codec_name || '',
        canais: stream.channels || null,
        idioma: tags.language || 'und',
        titulo: tags.title || '',
        // Faixa padrão do container: é a que o <video> nativo toca —
        // o player precisa saber qual é pra iniciar o seletor nela.
        padrao: Boolean(stream.disposition && stream.disposition.default),
      });
      audioIdx++;
    } else if (stream.codec_type === 'subtitle') {
      subtitles.push({
        index: subIdx,
        codec: stream.codec_name || '',
        idioma: tags.language || 'und',
        titulo: tags.title || '',
      });
      subIdx++;
    }
  }
  const duracao = Number(parsed.format && parsed.format.duration) || 0;
  return { video, audio, subtitles, duracao };
}

async function probeTracks(videoPath) {
  const mtimeMs = fs.statSync(videoPath).mtimeMs;
  const cached = trackCache.get(videoPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.tracks;

  const tracks = await probeTracksRaw(videoPath);
  trackCache.set(videoPath, { mtimeMs, tracks });
  return tracks;
}

function videoCacheKey(videoPath) {
  return crypto.createHash('sha1').update(videoPath).digest('hex').slice(0, 20);
}

function subsDirFor(videoPath) {
  return path.join(SUBS_CACHE_ROOT, videoCacheKey(videoPath));
}

// Extrações de legenda em andamento, pra duas requisições simultâneas pro
// mesmo arquivo+faixa não dispararem dois ffmpeg em paralelo à toa.
const subtitleExtractions = new Map(); // "videoPath:subIndex" -> Promise<caminhoVtt>

// Extrai (ou reaproveita do cache) uma faixa de legenda em WebVTT puro.
// É rápido e leve (só lê os pacotes de legenda, não toca no vídeo) e o
// resultado é um arquivo de texto de poucos KB — fica em cache até o vídeo
// ser removido (ver forgetVideo).
function getSubtitle(videoPath, subIndex) {
  // floor: mtimeMs pode vir com fração de milissegundo — sem arredondar, o
  // nome do arquivo ganharia um ".7666" no meio e cada stat poderia gerar
  // um nome ligeiramente diferente.
  const mtimeMs = Math.floor(fs.statSync(videoPath).mtimeMs);
  const dir = subsDirFor(videoPath);
  const outPath = path.join(dir, `${subIndex}-${mtimeMs}.vtt`);

  if (fs.existsSync(outPath)) return Promise.resolve(outPath);

  const chave = `${videoPath}:${subIndex}`;
  const emAndamento = subtitleExtractions.get(chave);
  if (emAndamento) return emAndamento;

  const promise = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${outPath}.${process.pid}.tmp`;
    // "-f webvtt" explícito é obrigatório: o ffmpeg infere o formato de
    // saída pela EXTENSÃO do arquivo, e o temporário termina em ".tmp" —
    // sem o -f ele aborta com "Unable to choose an output format".
    const args = ['-y', '-i', videoPath, '-map', `0:s:${subIndex}`, '-c:s', 'webvtt', '-f', 'webvtt', tmpPath];
    try {
      await runFfmpeg(args);
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      throw err;
    }
    fs.renameSync(tmpPath, outPath);
    return outPath;
  })().finally(() => subtitleExtractions.delete(chave));

  subtitleExtractions.set(chave, promise);
  return promise;
}

// Extrações de áudio em andamento (mesma ideia do subtitleExtractions).
const audioExtractions = new Map(); // "videoPath:audioIndex" -> Promise<caminhoM4a>

// Extrai (ou reaproveita do cache) uma faixa de áudio como .m4a — é o que
// permite trocar de dublagem em navegador sem a API audioTracks (só o
// Safari expõe): o player toca esta faixa num <audio> sincronizado com o
// vídeo mutado. Faixa já em AAC é copiada sem re-encode (segundos, mesmo
// num filme inteiro); outros codecs (ac3/eac3/dts...) viram AAC 256k —
// operação só de áudio, leve perto de qualquer encode de vídeo. O cache
// mora na mesma pasta por vídeo das legendas, então o forgetVideo já
// limpa tudo junto.
function getAudioTrack(videoPath, audioIndex) {
  const mtimeMs = Math.floor(fs.statSync(videoPath).mtimeMs);
  const dir = subsDirFor(videoPath);
  const outPath = path.join(dir, `audio-${audioIndex}-${mtimeMs}.m4a`);

  if (fs.existsSync(outPath)) return Promise.resolve(outPath);

  const chave = `${videoPath}:${audioIndex}`;
  const emAndamento = audioExtractions.get(chave);
  if (emAndamento) return emAndamento;

  const promise = (async () => {
    const tracks = await probeTracks(videoPath);
    const faixa = tracks.audio[audioIndex];
    if (!faixa) throw new Error(`faixa de áudio ${audioIndex} não existe em ${path.basename(videoPath)}`);
    const codecArgs = faixa.codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '256k'];

    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${outPath}.${process.pid}.tmp`;
    // "-f mp4" explícito pelo mesmo motivo do "-f webvtt" acima (o
    // temporário termina em .tmp); +faststart põe o moov no início — o
    // <audio> ganha duração e seek imediatos via range requests.
    const args = ['-y', '-i', videoPath, '-map', `0:a:${audioIndex}`, ...codecArgs, '-vn', '-sn', '-movflags', '+faststart', '-f', 'mp4', tmpPath];
    try {
      await runFfmpeg(args);
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      throw err;
    }
    fs.renameSync(tmpPath, outPath);
    return outPath;
  })().finally(() => audioExtractions.delete(chave));

  audioExtractions.set(chave, promise);
  return promise;
}

// Chamado quando um vídeo é removido de media/movies/ (ver
// routes/movies.js -> sincronizarCatalogo, que já detecta arquivos
// ausentes pra atualizar data/catalog.json). Libera o que esse vídeo
// deixou pra trás: a entrada em memória do ffprobe e a pasta inteira de
// legendas extraídas em cache/subs/.
function forgetVideo(videoPath) {
  trackCache.delete(videoPath);

  const dir = subsDirFor(videoPath);
  fs.rm(dir, { recursive: true, force: true }, (err) => {
    if (err) logManager.registrarErro('media', `falha ao limpar cache de legendas de ${path.basename(videoPath)}: ${err.message}`);
  });
}

// probeFile: mesma sondagem, mas SEM cache — usado pelo worker de re-encode
// pra verificar o arquivo de SAÍDA recém-gerado (um temporário que nem deve
// entrar no cache por mtime).
module.exports = { probeTracks, probeFile: probeTracksRaw, getSubtitle, getAudioTrack, forgetVideo };
