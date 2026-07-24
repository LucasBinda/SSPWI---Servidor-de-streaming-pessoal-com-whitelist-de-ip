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

// Chamado quando /media/tracks responde — popula os seletores do painel.
export function preencherFaixas(tracks, video, arquivo) {
  const selectAudio = document.getElementById('select-audio');
  const selectLegenda = document.getElementById('select-legenda');

  tracks.audio.forEach((faixa) => {
    const opt = document.createElement('option');
    opt.value = String(faixa.index);
    opt.textContent = rotuloFaixa(faixa, 'audio');
    selectAudio.appendChild(opt);
  });

  // O seletor começa na faixa padrão do container — é a que o <video>
  // nativo está tocando (sem flag "default", os navegadores tocam a
  // primeira).
  const idxPadrao = Math.max(0, tracks.audio.findIndex((faixa) => faixa.padrao));
  selectAudio.value = String(idxPadrao);

  if (tracks.audio.length <= 1) {
    selectAudio.disabled = true;
    selectAudio.title = 'Este arquivo tem uma única faixa de áudio.';
  } else {
    selectAudio.disabled = false;
    configurarTrocaDeAudio({ arquivo, video, selectAudio, idxPadrao });
  }

  tracks.subtitles.forEach((faixa) => {
    const opt = document.createElement('option');
    opt.value = String(faixa.index);
    opt.textContent = rotuloFaixa(faixa, 'legenda');
    selectLegenda.appendChild(opt);
  });
}

// Grafo de áudio COMPARTILHADO (reforço de volume + equalizador + troca de
// faixa). createMediaElementSource só pode ser chamado UMA vez por elemento
// — a partir daí todo o áudio do <video> sai pelo grafo, então quem precisa
// mexer no som passa por aqui.
//
// Cadeia fixa: source -> torneira -> boost -> (destino | cadeia do EQ).
// - "torneira": nó de ganho logo depois da fonte, que a troca de faixa fecha
//   (gain 0) pra silenciar a faixa embutida SEM tocar em video.muted — assim
//   a barra nativa de volume/mudo continua funcionando (e é espelhada na
//   faixa externa), em vez de brigar com o usuário re-mutando o vídeo.
// - "boost": ganho >= 1 que amplifica além do máximo do <video> nativo (o
//   volume nativo trava em 1.0). É também o nó que a religação do EQ move
//   entre o destino e a cadeia de processamento — por isso ele fica no fim
//   da parte fixa do grafo, valendo com ou sem equalizador.
let grafoAudio = null;
function obterGrafoDeAudio(video) {
  if (!grafoAudio) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaElementSource(video);
    const torneira = ctx.createGain();
    const boost = ctx.createGain();
    source.connect(torneira);
    torneira.connect(boost);
    boost.connect(ctx.destination); // caminho padrão; o EQ religa a saída do boost quando ativo
    grafoAudio = { ctx, torneira, boost };
  }
  if (grafoAudio.ctx.state === 'suspended') grafoAudio.ctx.resume();
  return grafoAudio;
}

// Troca de dublagem que funciona em QUALQUER navegador. A API audioTracks
// (que trocaria a faixa nativamente) só existe no Safari — em Chrome e
// Firefox o <video> toca pra sempre a faixa padrão do container. O
// contorno: o servidor extrai a faixa escolhida uma vez (/media/audio, com
// cache) e ela toca num <audio> invisível sincronizado com o vídeo,
// enquanto a torneira do grafo silencia a faixa embutida. Voltar pra faixa
// padrão desfaz tudo. A sincronia espelha play/pause/seek/velocidade e
// corrige deriva acima de 0.3s a cada 2s. (A faixa externa não passa pelo
// equalizador — limitação aceita pra não complicar o grafo.)
function configurarTrocaDeAudio({ arquivo, video, selectAudio, idxPadrao }) {
  let audioEl = null;
  let sincronizador = null;

  function resync() {
    if (audioEl) audioEl.currentTime = video.currentTime;
  }

  function desligarFaixaExterna() {
    if (!audioEl) return;
    clearInterval(sincronizador);
    sincronizador = null;
    audioEl.pause();
    audioEl.removeAttribute('src');
    audioEl = null;
    if (grafoAudio) grafoAudio.torneira.gain.value = 1; // reabre o som embutido
  }

  // Listeners registrados uma única vez; só agem com faixa externa ativa.
  video.addEventListener('play', () => {
    if (!audioEl) return;
    resync();
    audioEl.play().catch(() => {});
  });
  video.addEventListener('pause', () => {
    if (audioEl) audioEl.pause();
  });
  video.addEventListener('seeked', resync);
  // Buffering do vídeo: segura o áudio junto, senão ele segue sozinho.
  video.addEventListener('waiting', () => {
    if (audioEl) audioEl.pause();
  });
  video.addEventListener('playing', () => {
    if (!audioEl) return;
    resync();
    audioEl.play().catch(() => {});
  });
  video.addEventListener('ratechange', () => {
    if (audioEl) audioEl.playbackRate = video.playbackRate;
  });
  // Volume e mudo da barra nativa valem pra faixa externa também — espelho
  // simples, sem forçar estado nenhum no vídeo.
  video.addEventListener('volumechange', () => {
    if (!audioEl) return;
    audioEl.volume = video.volume;
    audioEl.muted = video.muted;
  });

  selectAudio.addEventListener('change', () => {
    const idx = Number(selectAudio.value);
    desligarFaixaExterna();
    if (idx === idxPadrao) return; // faixa padrão = caminho nativo do <video>

    // Fecha a torneira já: silêncio enquanto a faixa nova carrega — melhor
    // que continuar ouvindo o idioma antigo depois de já ter escolhido outro.
    obterGrafoDeAudio(video).torneira.gain.value = 0;

    const el = new Audio(`/media/audio?arquivo=${encodeURIComponent(arquivo)}&faixa=${idx}`);
    audioEl = el;
    el.preload = 'auto';
    el.volume = video.volume;
    el.muted = video.muted;
    el.playbackRate = video.playbackRate;

    // Eventos comparam com audioEl: se o usuário trocou de faixa de novo
    // durante o carregamento, os eventos do elemento antigo não podem
    // mexer no novo.
    el.addEventListener('canplay', () => {
      if (audioEl !== el) return;
      resync();
      if (!video.paused) el.play().catch(() => {});
    }, { once: true });

    el.addEventListener('error', () => {
      if (audioEl !== el) return;
      console.error('[player] falha ao carregar a faixa de áudio alternativa');
      desligarFaixaExterna();
      selectAudio.value = String(idxPadrao);
    });

    sincronizador = setInterval(() => {
      if (!audioEl || video.paused) return;
      if (Math.abs(audioEl.currentTime - video.currentTime) > 0.3) resync();
    }, 2000);
  });
}

// Equalizador via Web Audio API, ligado/desligado pelo interruptor ao lado
// do texto "Equalizador de áudio". Usa o grafo compartilhado (ver
// obterGrafoDeAudio): ligar religa a torneira na cadeia compressor+filtros,
// desligar religa direto no destino — bypass real, que tira o processamento
// do caminho do som sem desmontar nada. O AudioContext só pode ser criado/
// retomado a partir de um gesto do usuário (política de autoplay), por isso
// tudo é montado preguiçosamente. Estado (ligado + ganhos por banda)
// persiste no localStorage do navegador.
export function configurarEqualizador(video) {
  const toggleEq = document.getElementById('toggle-equalizador');
  const painelEq = document.getElementById('painel-equalizador');

  const BANDAS_HZ = [60, 170, 350, 1000, 3500, 10000];
  const CHAVE_STORAGE = 'sspwi-equalizador';

  let entradaCadeia = null; // primeiro nó da cadeia (compressor); null = não montada
  const filtros = [];

  let estado = { ligado: false, ganhos: BANDAS_HZ.map(() => 0) };
  try {
    const salvo = JSON.parse(localStorage.getItem(CHAVE_STORAGE));
    if (salvo && Array.isArray(salvo.ganhos) && salvo.ganhos.length === BANDAS_HZ.length) {
      estado = { ligado: Boolean(salvo.ligado), ganhos: salvo.ganhos.map(Number) };
    }
  } catch {
    /* JSON corrompido no storage — segue com o padrão neutro */
  }
  const salvarEstado = () => localStorage.setItem(CHAVE_STORAGE, JSON.stringify(estado));

  // Os sliders de banda existem desde a carga da página (mostrando os ganhos
  // salvos), independente do grafo de áudio — que pode nem ter sido montado
  // ainda. Mexer num slider guarda o ganho e, se o grafo existir, aplica.
  BANDAS_HZ.forEach((freq, i) => {
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
    slider.value = String(estado.ganhos[i]);
    slider.className = 'slider-eq';
    slider.setAttribute('aria-label', `Ganho em ${rotulo.textContent}`);

    const valor = document.createElement('span');
    valor.className = 'valor-eq';

    const formatar = (db) => `${db > 0 ? '+' : ''}${db}dB`;
    valor.textContent = formatar(estado.ganhos[i]);

    slider.addEventListener('input', () => {
      const db = Number(slider.value);
      estado.ganhos[i] = db;
      if (filtros[i]) filtros[i].gain.value = db;
      valor.textContent = formatar(db);
      salvarEstado();
    });

    linha.appendChild(rotulo);
    linha.appendChild(slider);
    linha.appendChild(valor);
    painelEq.appendChild(linha);
  });

  function montarCadeia() {
    if (entradaCadeia) return;
    const { ctx } = obterGrafoDeAudio(video);

    // Nivelamento automático de volume (trecho muito alto abaixa um pouco,
    // trecho muito baixo sobe um pouco). Isso é dinâmica de AMPLITUDE — não
    // tem relação com as bandas de frequência, que aplicam os ganhos salvos.
    // threshold/ratio moderados (não é um limiter agressivo) + um pequeno
    // ganho de compensação depois, pra recuperar o volume médio que a
    // compressão tira.
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -30;
    compressor.knee.value = 20;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.02;
    compressor.release.value = 0.3;

    const ganhoCompensacao = ctx.createGain();
    ganhoCompensacao.gain.value = 1.4; // ~+3dB, compensa a redução média da compressão

    entradaCadeia = compressor;
    compressor.connect(ganhoCompensacao);

    let node = ganhoCompensacao;
    BANDAS_HZ.forEach((freq, i) => {
      const filtro = ctx.createBiquadFilter();
      filtro.type = 'peaking';
      filtro.frequency.value = freq;
      filtro.Q.value = 1;
      filtro.gain.value = estado.ganhos[i];
      node.connect(filtro);
      node = filtro;
      filtros[i] = filtro;
    });
    node.connect(ctx.destination);
  }

  function ligar() {
    montarCadeia();
    const { boost } = obterGrafoDeAudio(video);
    boost.disconnect();
    boost.connect(entradaCadeia);
    painelEq.hidden = false;
  }

  function desligar() {
    // Bypass real: a saída do boost volta a despejar direto no destino, sem
    // compressor nem filtros. (Cadeia nunca montada = nada a religar.)
    if (entradaCadeia) {
      const { ctx, boost } = obterGrafoDeAudio(video);
      boost.disconnect();
      boost.connect(ctx.destination);
    }
    painelEq.hidden = true;
  }

  toggleEq.addEventListener('change', () => {
    estado.ligado = toggleEq.checked;
    salvarEstado();
    if (toggleEq.checked) ligar();
    else desligar();
  });

  // Sessão anterior deixou o equalizador ligado: o interruptor e os sliders
  // já aparecem ativos, mas o AudioContext precisa de um gesto — o grafo
  // engata no primeiro clique/tecla (até lá o vídeo toca pelo caminho
  // nativo, sem processamento, o que é inaudível na prática).
  if (estado.ligado) {
    toggleEq.checked = true;
    painelEq.hidden = false;
    const engatar = () => {
      if (toggleEq.checked && !entradaCadeia) ligar();
    };
    document.addEventListener('pointerdown', engatar, { once: true });
    document.addEventListener('keydown', engatar, { once: true });
  }
}

// Reforço de volume: amplifica o áudio ALÉM do máximo do <video> nativo (que
// trava em 100%), pro caso de um filme baixo demais num cliente de som fraco.
// Atua no nó "boost" do grafo compartilhado; um fator de 1.0 (100%) é neutro.
// É uma preferência do DISPOSITIVO (localStorage, como o equalizador) — o
// volume nativo é que segue o usuário (ver prefs.js). Como mexer no áudio
// exige o AudioContext, que só liga a partir de um gesto, um fator salvo > 1
// só engata no primeiro clique/tecla (até lá o vídeo toca no caminho nativo,
// em 100% — inaudível como "falta de reforço", não como silêncio).
export function configurarReforcoVolume(video) {
  const slider = document.getElementById('slider-reforco');
  const valor = document.getElementById('valor-reforco');
  const CHAVE_STORAGE = 'sspwi-reforco-volume';

  let fator = 100; // porcentagem: 100 = neutro
  const salvo = Number(localStorage.getItem(CHAVE_STORAGE));
  if (Number.isFinite(salvo) && salvo >= 100 && salvo <= 300) fator = salvo;

  const refletir = () => {
    slider.value = String(fator);
    valor.textContent = `${fator}%`;
  };

  // Aplica no grafo (montando/retomando o AudioContext). Só deve ser chamado
  // a partir de um gesto do usuário — quem carrega do storage difere pro
  // primeiro gesto abaixo, pra não redirecionar o áudio pro grafo suspenso.
  const aplicar = () => {
    obterGrafoDeAudio(video).boost.gain.value = fator / 100;
  };

  refletir();

  slider.addEventListener('input', () => {
    const v = Number(slider.value);
    fator = Number.isFinite(v) ? Math.min(300, Math.max(100, v)) : 100;
    valor.textContent = `${fator}%`;
    localStorage.setItem(CHAVE_STORAGE, String(fator));
    // O próprio arraste é um gesto — seguro engatar o grafo e aplicar já.
    aplicar();
  });

  // Fator salvo de uma sessão anterior: o slider já mostra o valor, mas o
  // grafo só pode engatar num gesto (mesma restrição do equalizador).
  if (fator !== 100) {
    const engatar = () => aplicar();
    document.addEventListener('pointerdown', engatar, { once: true });
    document.addEventListener('keydown', engatar, { once: true });
  }
}
