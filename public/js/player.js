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
  // Fase 3: o /stream e o /media/* exigem sessão válida (token+cookie) —
  // garante antes de montar o player. Barrado -> mensagem + polling de 20s
  // até o acesso voltar (aí recarrega e o player monta normalmente).
  Auth.garantir().then((autorizado) => {
    if (autorizado) {
      iniciarPlayer(arquivo);
    } else {
      document.getElementById('descricao-filme').textContent =
        'Acesso negado pelo servidor. Tentando reautorizar automaticamente a cada 20 segundos…';
      Auth.iniciarPolling(() => window.location.reload());
    }
  });
}

// Reprodução direta via /stream (range requests) — o HLS on-the-fly foi
// revertido por pesar demais na CPU do servidor.
// Com range requests o próprio <video>
// nativo resolve seek pra qualquer ponto do arquivo, barra de progresso
// completa e buffer, sem nenhum processo de transcodificação rodando.
// A contrapartida: containers não-mp4 (mkv/avi) podem não tocar em todo
// navegador — a padronização pra mp4 é o trabalho da fase 2.
function iniciarPlayer(arquivo) {
  const video = document.getElementById('video-player');

  video.src = `/stream?arquivo=${encodeURIComponent(arquivo)}`;

  video.play().catch(() => {
    /* autoplay bloqueado pelo navegador — o usuário dá play manualmente */
  });

  // Formato que o navegador não decodifica (mkv no Safari, codec sem
  // suporte etc.) cai aqui — melhor uma mensagem clara do que um player
  // preto sem explicação.
  video.addEventListener('error', () => {
    document.getElementById('descricao-filme').textContent =
      'Seu navegador não conseguiu reproduzir este arquivo. Formatos como MKV/AVI ' +
      'dependem do navegador — este vídeo será convertido para MP4 pela otimização de armazenamento.';
  });

  configurarPainelConfiguracoes({ arquivo, video });
  configurarEqualizador(video);
  configurarWatchTime(arquivo, video);

  // Metadados (faixas de áudio/legenda) chegam em paralelo, sem bloquear o
  // início da reprodução acima.
  fetch(`/media/tracks?arquivo=${encodeURIComponent(arquivo)}`)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((tracks) => preencherFaixas(tracks, video))
    .catch((err) => console.error('[player] falha ao carregar metadados do vídeo:', err));
}

// Watch time: retoma o filme de onde o usuário parou e vai salvando a
// minutagem enquanto assiste. Toda gravação é um navigator.sendBeacon
// (POST minúsculo, parâmetros na query, resposta 204 sem corpo) — leve o
// suficiente pra rodar a cada 15s sem pesar, e o sendBeacon sobrevive ao
// fechamento da aba, que é justamente o momento mais importante de salvar.
// A minutagem pertence ao uid do cookie de login (o servidor extrai do
// cookie — nada de identidade viajando na URL).
function configurarWatchTime(arquivo, video) {
  const INTERVALO_SAVE_MS = 15 * 1000;
  const MINIMO_PARA_RETOMAR_S = 30;

  const salvar = (segundos) => {
    navigator.sendBeacon(
      `/watchtime/save?arquivo=${encodeURIComponent(arquivo)}&t=${Math.floor(segundos)}`
    );
  };

  // Retomada: busca a minutagem salva e pula pra ela (com 3s de recuo, pra
  // recuperar o contexto da cena). Perto do fim (>95%) não retoma — o
  // usuário terminou o filme; recomeça do zero.
  fetch(`/watchtime/get?arquivo=${encodeURIComponent(arquivo)}`)
    .then((res) => (res.ok ? res.json() : { segundos: 0 }))
    .then(({ segundos }) => {
      if (segundos < MINIMO_PARA_RETOMAR_S) return;
      const aplicar = () => {
        if (segundos > video.duration * 0.95) return;
        video.currentTime = Math.max(0, segundos - 3);
      };
      if (video.readyState >= 1) aplicar();
      else video.addEventListener('loadedmetadata', aplicar, { once: true });
    })
    .catch(() => {
      /* sem minutagem salva ou request falhou — começa do zero */
    });

  // Salva a cada 15s enquanto toca, ao pausar, e no fechamento da aba.
  let ultimoSave = 0;
  video.addEventListener('timeupdate', () => {
    if (video.paused || video.currentTime < 5) return;
    if (Date.now() - ultimoSave < INTERVALO_SAVE_MS) return;
    ultimoSave = Date.now();
    salvar(video.currentTime);
  });
  video.addEventListener('pause', () => {
    if (video.currentTime >= 5) salvar(video.currentTime);
  });
  const salvarAoSair = () => {
    if (video.currentTime >= 5 && !video.ended) salvar(video.currentTime);
  };
  window.addEventListener('pagehide', salvarAoSair);
  window.addEventListener('beforeunload', salvarAoSair);

  // Filme assistido até o fim: zera a minutagem — a próxima sessão começa
  // do início em vez de "retomar" nos créditos.
  video.addEventListener('ended', () => salvar(0));
}

function rotuloFaixa(faixa, tipo) {
  const partes = [];
  if (faixa.titulo) {
    partes.push(faixa.titulo);
  } else {
    partes.push(tipo === 'audio' ? `Áudio ${faixa.index + 1}` : `Legenda ${faixa.index + 1}`);
  }
  if (faixa.idioma && faixa.idioma !== 'und') partes.push(`(${faixa.idioma})`);
  if (tipo === 'audio' && faixa.canais) partes.push(`· ${faixa.canais}ch`);
  return partes.join(' ');
}

// Botão de engrenagem: abre/fecha o painel e liga o seletor de legenda.
// Legenda é extraída à parte via /media/subtitle (operação leve, com cache)
// e entra como uma <track> nativa do <video> — trocar de legenda nunca
// interrompe o vídeo que já está tocando.
function configurarPainelConfiguracoes({ arquivo, video }) {
  const btnConfig = document.getElementById('btn-config');
  const painel = document.getElementById('painel-config');
  const selectLegenda = document.getElementById('select-legenda');

  btnConfig.addEventListener('click', () => {
    const estaAberto = !painel.hidden;
    painel.hidden = estaAberto;
    btnConfig.setAttribute('aria-expanded', String(!estaAberto));
  });

  let trackEl = null;
  selectLegenda.addEventListener('change', () => {
    if (trackEl) {
      video.removeChild(trackEl);
      trackEl = null;
    }

    const subIndex = selectLegenda.value;
    if (subIndex === '') return;

    trackEl = document.createElement('track');
    trackEl.kind = 'subtitles';
    trackEl.label = selectLegenda.selectedOptions[0].textContent;
    trackEl.src = `/media/subtitle?arquivo=${encodeURIComponent(arquivo)}&sub=${encodeURIComponent(subIndex)}`;
    trackEl.default = true;
    video.appendChild(trackEl);

    // Adicionar <track> depois que o vídeo já está tocando nem sempre ativa
    // sozinho em todo navegador — força o modo "showing" quando o WebVTT
    // termina de carregar.
    trackEl.addEventListener('load', () => {
      if (trackEl.track) trackEl.track.mode = 'showing';
    });
  });
}

// Chamado quando /media/tracks responde — popula os seletores do painel.
function preencherFaixas(tracks, video) {
  const selectAudio = document.getElementById('select-audio');
  const selectLegenda = document.getElementById('select-legenda');

  tracks.audio.forEach((faixa) => {
    const opt = document.createElement('option');
    opt.value = String(faixa.index);
    opt.textContent = rotuloFaixa(faixa, 'audio');
    selectAudio.appendChild(opt);
  });

  // Troca de dublagem sem transcodificação no servidor depende da API
  // audioTracks do próprio navegador (Safari tem; Chrome/Firefox ainda
  // escondem atrás de flag). Três cenários, cada um explicado no tooltip
  // em vez de um seletor mudo:
  // 1. arquivo com UMA faixa: nada a trocar — o normal do acervo, já que a
  //    padronização define a faixa dublada como padrão do container;
  // 2. várias faixas + navegador com audioTracks: troca ao vivo funciona;
  // 3. várias faixas sem a API: seletor mostra o que existe, mas explica
  //    que o navegador não expõe a troca.
  const suporteNativo = typeof video.audioTracks !== 'undefined';
  if (tracks.audio.length <= 1) {
    selectAudio.disabled = true;
    selectAudio.title = 'Este arquivo tem uma única faixa de áudio.';
  } else if (suporteNativo) {
    selectAudio.disabled = false;
    selectAudio.addEventListener('change', () => {
      const escolhida = Number(selectAudio.value);
      for (let i = 0; i < video.audioTracks.length; i++) {
        video.audioTracks[i].enabled = i === escolhida;
      }
    });
  } else {
    selectAudio.disabled = true;
    selectAudio.title =
      'Seu navegador não expõe troca de faixa de áudio (API audioTracks). ' +
      'No Safari funciona; em Chrome/Firefox a faixa padrão do arquivo é a que toca.';
  }

  tracks.subtitles.forEach((faixa) => {
    const opt = document.createElement('option');
    opt.value = String(faixa.index);
    opt.textContent = rotuloFaixa(faixa, 'legenda');
    selectLegenda.appendChild(opt);
  });
}

// Equalizador via Web Audio API. O AudioContext só pode ser criado (ou
// retomado, se suspenso) a partir de um gesto do usuário — política de
// autoplay dos navegadores — então todo o grafo de áudio é montado de
// forma preguiçosa, só no primeiro clique em "Equalizador".
function configurarEqualizador(video) {
  const btnEq = document.getElementById('btn-equalizador');
  const painelEq = document.getElementById('painel-equalizador');

  const BANDAS_HZ = [60, 170, 350, 1000, 3500, 10000];
  let audioCtx = null;

  function montarGrafoDeAudio() {
    if (audioCtx) return;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // createMediaElementSource só pode ser chamado UMA vez por elemento, e
    // a partir daí TODO o áudio do <video> passa a sair pelo grafo do Web
    // Audio API — por isso a cadeia precisa terminar em audioCtx.destination,
    // senão o áudio simplesmente emudece.
    const source = audioCtx.createMediaElementSource(video);

    // Nivelamento automático de volume, ligado por padrão (trecho muito
    // alto abaixa um pouco, trecho muito baixo sobe um pouco). Isso é
    // dinâmica de AMPLITUDE — não tem relação com as bandas de frequência
    // abaixo, que continuam neutras (0dB) até o usuário mexer.
    // threshold/ratio moderados (não é um limiter agressivo) + um pequeno
    // ganho de compensação depois, pra recuperar o volume médio que a
    // compressão tira.
    const compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.value = -30;
    compressor.knee.value = 20;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.02;
    compressor.release.value = 0.3;

    const ganhoCompensacao = audioCtx.createGain();
    ganhoCompensacao.gain.value = 1.4; // ~+3dB, compensa a redução média da compressão

    source.connect(compressor);
    let node = ganhoCompensacao;
    compressor.connect(ganhoCompensacao);

    BANDAS_HZ.forEach((freq) => {
      const filtro = audioCtx.createBiquadFilter();
      filtro.type = 'peaking';
      filtro.frequency.value = freq;
      filtro.Q.value = 1;
      filtro.gain.value = 0;
      node.connect(filtro);
      node = filtro;

      const linha = document.createElement('div');
      linha.className = 'linha-eq';

      const rotulo = document.createElement('label');
      rotulo.className = 'rotulo-eq';
      rotulo.textContent = freq >= 1000 ? `${freq / 1000}kHz` : `${freq}Hz`;

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '-12';
      slider.max = '12';
      slider.step = '1';
      slider.value = '0';
      slider.className = 'slider-eq';
      slider.setAttribute('aria-label', `Ganho em ${rotulo.textContent}`);

      const valor = document.createElement('span');
      valor.className = 'valor-eq';
      valor.textContent = '0dB';

      slider.addEventListener('input', () => {
        const db = Number(slider.value);
        filtro.gain.value = db;
        valor.textContent = `${db > 0 ? '+' : ''}${db}dB`;
      });

      linha.appendChild(rotulo);
      linha.appendChild(slider);
      linha.appendChild(valor);
      painelEq.appendChild(linha);
    });
    node.connect(audioCtx.destination);
  }

  btnEq.addEventListener('click', () => {
    montarGrafoDeAudio();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const estaAberto = !painelEq.hidden;
    painelEq.hidden = estaAberto;
    btnEq.setAttribute('aria-expanded', String(!estaAberto));
  });
}
