const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Este módulo é o que SOBROU da reversão do HLS on-the-fly:
// só as operações de mídia baratas em CPU —
// sondar faixas com ffprobe e extrair legendas em WebVTT. A transcodificação
// de vídeo em tempo real (sessões de ffmpeg por playback) foi removida por
// pesar demais no processador do servidor; o vídeo volta a ser servido
// direto pelo /stream com range requests.

// Cache de legendas extraídas (WebVTT), organizado por PASTA por vídeo —
// não por arquivo achatado — de propósito: quando um filme é removido de
// media/movies/, limpar tudo que ele deixou em cache vira um único rm -rf
// dessa pasta (ver forgetVideo), sem precisar saber de antemão quais índices
// de legenda foram extraídos.
const SUBS_CACHE_ROOT = path.join(__dirname, '..', 'cache', 'subs');

// Cache em memória de metadados de faixas por arquivo, invalidado se o
// arquivo mudar de mtime (por exemplo depois de um re-encode da fase 2).
// Evita rodar o ffprobe de novo toda vez que o usuário abre o player.
const trackCache = new Map(); // videoPath -> { mtimeMs, tracks }

function probeTracksRaw(videoPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      // format=duration junto dos streams: duração real do arquivo, usada
      // pelo front-end como fallback quando o <video> ainda não carregou
      // os metadados.
      '-show_entries', 'format=duration:stream=index,codec_type,codec_name,channels,pix_fmt:stream_tags=language,title',
      '-i', videoPath,
    ];
    const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk) => { out += chunk; });
    proc.stderr.on('data', (chunk) => { err += chunk; });
    proc.on('error', (spawnErr) => {
      reject(new Error(`falha ao iniciar ffprobe (está instalado e no PATH?): ${spawnErr.message}`));
    });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe saiu com código ${code}: ${err.trim()}`));
      try {
        const parsed = JSON.parse(out);
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
        resolve({ video, audio, subtitles, duracao });
      } catch (parseErr) {
        reject(parseErr);
      }
    });
  });
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

  const promise = new Promise((resolve, reject) => {
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${outPath}.${process.pid}.tmp`;
    // "-f webvtt" explícito é obrigatório: o ffmpeg infere o formato de
    // saída pela EXTENSÃO do arquivo, e o temporário termina em ".tmp" —
    // sem o -f ele aborta com "Unable to choose an output format".
    const args = ['-y', '-i', videoPath, '-map', `0:s:${subIndex}`, '-c:s', 'webvtt', '-f', 'webvtt', tmpPath];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', (err) => reject(new Error(`falha ao iniciar ffmpeg: ${err.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        fs.rm(tmpPath, { force: true }, () => {});
        return reject(new Error(`ffmpeg saiu com código ${code}: ${stderr.trim()}`));
      }
      fs.rename(tmpPath, outPath, (renameErr) => {
        if (renameErr) return reject(renameErr);
        resolve(outPath);
      });
    });
  }).finally(() => subtitleExtractions.delete(chave));

  subtitleExtractions.set(chave, promise);
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
    if (err) console.error(`[media] falha ao limpar cache de legendas de ${path.basename(videoPath)}:`, err.message);
  });
}

// probeFile: mesma sondagem, mas SEM cache — usado pelo worker de re-encode
// pra verificar o arquivo de SAÍDA recém-gerado (um temporário que nem deve
// entrar no cache por mtime).
module.exports = { probeTracks, probeFile: probeTracksRaw, getSubtitle, forgetVideo };
