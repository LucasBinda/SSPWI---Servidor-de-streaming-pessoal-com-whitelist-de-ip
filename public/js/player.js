const params = new URLSearchParams(window.location.search);
const arquivo = params.get('arquivo');
const titulo = params.get('titulo') || '';
const descricao = params.get('descricao') || '';

document.getElementById('titulo-filme').textContent = titulo;
document.getElementById('descricao-filme').textContent = descricao;
document.title = titulo ? `${titulo} — Sala de projeção` : 'Assistindo — Sala de projeção';

if (!arquivo) {
  window.location.href = '/';
} else {
  iniciarPlayer(arquivo);
}

// Fase 1 (HLS on-the-fly): troca o /stream direto por um manifesto .m3u8
// gerado sob demanda pelo ffmpeg no backend (routes/hls.js). Isso resolve
// o "erro de rede" e a trava no seek que aconteciam com containers que não
// são .mp4 faststart — o player agora troca segmentos discretos em vez de
// pular pra bytes arbitrários do arquivo original.
//
// Seletor de áudio/legenda e equalizador entram numa fase seguinte; por
// enquanto é sempre audio=0 (primeira faixa de áudio do arquivo).
function iniciarPlayer(arquivo) {
  const video = document.getElementById('video-player');
  const manifestUrl = `/hls/manifest?arquivo=${encodeURIComponent(arquivo)}&audio=0`;

  if (Hls.isSupported()) {
    const hls = new Hls({
      maxBufferLength: 30,
      // o manifesto pode não ter #EXT-X-ENDLIST ainda (ffmpeg ainda
      // transcodificando) — o hls.js já sabe recarregar como "event" stream
      // nesse caso, sem configuração extra.
    });

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      console.error('[player] erro fatal do hls.js:', data.type, data.details);
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        hls.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      }
    });

    hls.loadSource(manifestUrl);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari toca HLS nativamente, sem precisar do hls.js
    video.src = manifestUrl;
  } else {
    document.getElementById('descricao-filme').textContent =
      'Seu navegador não tem suporte a HLS. Atualize o navegador ou use outro.';
    return;
  }

  video.play().catch(() => {
    /* autoplay bloqueado pelo navegador — o usuário dá play manualmente */
  });

  // Avisa o backend pra encerrar o ffmpeg e limpar o cache assim que o
  // vídeo é fechado, em vez de esperar os 2min do reaper — importante
  // porque o servidor tem pouco espaço em disco.
  const fecharSessao = () => {
    navigator.sendBeacon(`/hls/close?arquivo=${encodeURIComponent(arquivo)}&audio=0`);
  };
  window.addEventListener('beforeunload', fecharSessao);
  window.addEventListener('pagehide', fecharSessao);
}
