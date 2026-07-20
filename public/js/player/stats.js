// Painel de "stats de nerd": dados técnicos do playback no canto superior
// esquerdo, sobre o filme. Ligado por um interruptor no menu de config, com a
// escolha persistida no localStorage. Enquanto visível, atualiza 2x/segundo.
export function configurarStatsNerd(tracks, video, arquivo) {
  const overlay = document.getElementById('stats-nerd');
  const toggle = document.getElementById('toggle-stats');
  const selectAudio = document.getElementById('select-audio');
  const CHAVE_STORAGE = 'sspwi-stats-nerd';
  let timer = null;
  let tamanhoBytes = null;

  // Tamanho do arquivo (pra estimar o bitrate médio) sem baixá-lo: um range
  // mínimo devolve "Content-Range: bytes 0-0/TOTAL" — daí sai o total.
  fetch(`/stream?arquivo=${encodeURIComponent(arquivo)}`, { headers: { Range: 'bytes=0-0' } })
    .then((res) => {
      const total = (res.headers.get('content-range') || '').split('/')[1];
      if (total) tamanhoBytes = Number(total);
    })
    .catch(() => {
      /* sem tamanho -> painel só omite bitrate/tamanho */
    });

  // FPS estimado pela variação de totalVideoFrames entre duas atualizações
  // (o <video> não expõe o FPS do arquivo diretamente).
  let ultFrames = null;
  let ultMs = 0;
  let fps = 0;

  const pad = (n) => String(n).padStart(2, '0');
  const fmtTempo = (s) => {
    if (!isFinite(s)) return '--:--';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const seg = Math.floor(s % 60);
    return h > 0 ? `${h}:${pad(m)}:${pad(seg)}` : `${pad(m)}:${pad(seg)}`;
  };

  // Monta a lista [rótulo, valor] do estado atual. Valores são sempre texto.
  function coletar() {
    const L = [];
    L.push(['Resolução', video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : '—']);

    const v0 = tracks.video[0] || {};
    L.push(['Vídeo', [v0.codec, v0.pixFmt].filter(Boolean).join(' ') || '—']);

    const fa = tracks.audio[Number(selectAudio.value || 0)];
    if (fa) {
      const partes = [fa.codec];
      if (fa.canais) partes.push(`${fa.canais}ch`);
      if (fa.idioma && fa.idioma !== 'und') partes.push(`(${fa.idioma})`);
      L.push(['Áudio', partes.join(' ')]);
    }

    if (typeof video.getVideoPlaybackQuality === 'function') {
      const q = video.getVideoPlaybackQuality();
      const agora = performance.now();
      if (ultFrames !== null && agora > ultMs) {
        fps = (q.totalVideoFrames - ultFrames) / ((agora - ultMs) / 1000);
      }
      ultFrames = q.totalVideoFrames;
      ultMs = agora;
      if (!video.paused) L.push(['FPS', fps.toFixed(1)]);
      L.push(['Frames caídos', `${q.droppedVideoFrames} / ${q.totalVideoFrames}`]);
    }

    // Segundos de vídeo já bufferizados à frente do ponto atual.
    let bufAhead = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)) {
        bufAhead = video.buffered.end(i) - video.currentTime;
        break;
      }
    }
    L.push(['Buffer', `${bufAhead.toFixed(0)}s à frente`]);
    L.push(['Tempo', `${fmtTempo(video.currentTime)} / ${fmtTempo(video.duration)}`]);
    if (video.playbackRate !== 1) L.push(['Velocidade', `${video.playbackRate}×`]);
    L.push(['Volume', video.muted ? 'mudo' : `${Math.round(video.volume * 100)}%`]);

    if (tamanhoBytes && video.duration) {
      L.push(['Bitrate méd.', `${(tamanhoBytes * 8 / video.duration / 1e6).toFixed(1)} Mbps`]);
      L.push(['Tamanho', `${(tamanhoBytes / 1e9).toFixed(2)} GB`]);
    }
    return L;
  }

  // Reconstrói o overlay via DOM (createElement + textContent) — NUNCA
  // innerHTML com dados dinâmicos: codec/idioma vêm do metadata do arquivo.
  function atualizar() {
    overlay.textContent = '';
    for (const [rotulo, valor] of coletar()) {
      const linha = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = rotulo;
      linha.append(b, document.createTextNode(valor));
      overlay.appendChild(linha);
    }
  }

  function mostrar(ligado) {
    toggle.checked = ligado;
    overlay.hidden = !ligado;
    clearInterval(timer);
    if (ligado) {
      atualizar();
      timer = setInterval(atualizar, 500);
    }
    localStorage.setItem(CHAVE_STORAGE, ligado ? '1' : '0');
  }

  toggle.addEventListener('change', () => mostrar(toggle.checked));
  if (localStorage.getItem(CHAVE_STORAGE) === '1') mostrar(true);
}
