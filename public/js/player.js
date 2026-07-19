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
  configurarOcultarConfigOcioso(video);
  configurarModosDeTela(video);
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
// Legenda é extraída à parte via /media/subtitle (operação leve, com cache),
// mas NÃO entra como <track> nativa: o navegador cria sozinho um botão "CC"
// na barra de controles quando existe uma faixa de texto, e não há CSS
// confiável pra escondê-lo no Chrome. Em vez disso o próprio player baixa o
// WebVTT, interpreta as cues e desenha a legenda numa camada sobre o vídeo
// (.legenda-overlay) — mesma função, barra limpa. Trocar de legenda continua
// sem interromper o vídeo que já está tocando.
function configurarPainelConfiguracoes({ arquivo, video }) {
  const btnConfig = document.getElementById('btn-config');
  const painel = document.getElementById('painel-config');
  const selectLegenda = document.getElementById('select-legenda');
  const overlay = document.getElementById('legenda-overlay');

  btnConfig.addEventListener('click', () => {
    const estaAberto = !painel.hidden;
    painel.hidden = estaAberto;
    btnConfig.setAttribute('aria-expanded', String(!estaAberto));
  });

  let cues = [];
  let ultimoHtml = '';

  // Redesenha só quando o conjunto de cues visíveis muda — o timeupdate
  // dispara ~4x por segundo e mexer no DOM à toa não faz sentido.
  function atualizarLegenda() {
    const t = video.currentTime;
    const html = cues
      .filter((cue) => t >= cue.inicio && t <= cue.fim)
      .map((cue) => cue.html)
      .join('<br>');
    if (html === ultimoHtml) return;
    ultimoHtml = html;
    overlay.innerHTML = html;
    overlay.hidden = html === '';
  }
  video.addEventListener('timeupdate', atualizarLegenda);
  video.addEventListener('seeked', atualizarLegenda);

  selectLegenda.addEventListener('change', () => {
    cues = [];
    ultimoHtml = '';
    overlay.innerHTML = '';
    overlay.hidden = true;

    const subIndex = selectLegenda.value;
    if (subIndex === '') return;

    fetch(`/media/subtitle?arquivo=${encodeURIComponent(arquivo)}&sub=${encodeURIComponent(subIndex)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((vtt) => {
        cues = parseWebVTT(vtt);
        atualizarLegenda();
      })
      .catch((err) => console.error('[player] falha ao carregar legenda:', err));
  });
}

// Parser de WebVTT mínimo: só o que o /media/subtitle gera (blocos de cue
// separados por linha em branco, timestamps "HH:MM:SS.mmm --> HH:MM:SS.mmm").
// Posicionamento avançado de cue (align, line etc.) é ignorado — a legenda
// sempre aparece centralizada no rodapé do vídeo.
function parseWebVTT(texto) {
  const cues = [];
  const blocos = texto.replace(/\r/g, '').split(/\n\n+/);

  for (const bloco of blocos) {
    const linhas = bloco.split('\n').filter((l) => l.trim() !== '');
    const idxTempo = linhas.findIndex((l) => l.includes('-->'));
    if (idxTempo === -1) continue;

    const [inicioBruto, fimBruto] = linhas[idxTempo].split('-->');
    const inicio = parseTempoVTT(inicioBruto);
    const fim = parseTempoVTT(fimBruto);
    if (inicio === null || fim === null) continue;

    const corpo = linhas.slice(idxTempo + 1).join('\n');
    if (corpo === '') continue;
    cues.push({ inicio, fim, html: cueParaHtml(corpo) });
  }
  return cues;
}

// "01:02:03.456" ou "02:03.456" -> segundos (a hora é opcional no WebVTT).
function parseTempoVTT(bruto) {
  const m = bruto.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})/);
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

// O texto da cue vai pro innerHTML do overlay, então tudo é escapado primeiro
// e só itálico/negrito/sublinhado (formatação comum em legendas) volta a ser
// tag de verdade. O resto das tags de VTT (<v>, <c>, timestamps) é descartado.
function cueParaHtml(texto) {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;(\/?)(i|b|u)&gt;/gi, '<$1$2>')
    .replace(/&lt;\/?[^&]*?&gt;/g, '')
    .replace(/\n/g, '<br>');
}

// A engrenagem acompanha a barra de controles nativa: some depois de ~3s sem
// atividade com o vídeo tocando (mesmo timeout do Chrome) pra não ficar na
// frente do filme, e reaparece ao mexer o mouse ou tocar na tela. Nunca some
// com o vídeo pausado (a barra nativa também não some) nem com o painel de
// configurações aberto.
function configurarOcultarConfigOcioso(video) {
  const shell = document.querySelector('.video-shell');
  const painel = document.getElementById('painel-config');
  const OCIOSO_MS = 3000;
  let timer = null;

  function esconder() {
    if (video.paused || !painel.hidden) return;
    shell.classList.add('controles-ocultos');
  }

  function mostrar() {
    shell.classList.remove('controles-ocultos');
    clearTimeout(timer);
    timer = setTimeout(esconder, OCIOSO_MS);
  }

  shell.addEventListener('pointermove', mostrar);
  shell.addEventListener('pointerdown', mostrar);
  shell.addEventListener('focusin', mostrar);
  // Cursor saiu do vídeo: esconde já, sem esperar o timeout
  shell.addEventListener('pointerleave', () => {
    clearTimeout(timer);
    esconder();
  });
  video.addEventListener('pause', mostrar);
  // O play (inclusive o autoplay) arma a contagem — sem isso a engrenagem
  // ficaria pra sempre na tela se o mouse nunca passasse pelo vídeo.
  video.addEventListener('play', mostrar);
}

// Modo retrato: o filme ocupa a janela inteira do navegador (sem virar tela
// cheia do sistema — a aba e a barra do navegador continuam lá). Tela cheia:
// fullscreen de verdade, mas pedido no .video-shell em vez do <video>, pra
// legenda desenhada e a engrenagem continuarem visíveis por cima do filme.
function configurarModosDeTela(video) {
  const shell = document.querySelector('.video-shell');
  const btnRetrato = document.getElementById('btn-modo-retrato');
  const btnTelaCheia = document.getElementById('btn-tela-cheia');

  function definirRetrato(ligado) {
    document.body.classList.toggle('modo-retrato', ligado);
    btnRetrato.setAttribute('aria-pressed', String(ligado));
    btnRetrato.textContent = ligado ? 'Sair do retrato' : 'Modo retrato';
  }

  btnRetrato.addEventListener('click', () => {
    definirRetrato(!document.body.classList.contains('modo-retrato'));
  });

  // Esc sai do modo retrato — mas não quando a tela cheia está ativa, senão
  // um único Esc derrubaria os dois modos de uma vez (o navegador já usa
  // Esc pra sair do fullscreen).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.fullscreenElement) return;
    if (document.body.classList.contains('modo-retrato')) definirRetrato(false);
  });

  function alternarTelaCheia() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (shell.requestFullscreen) {
      shell.requestFullscreen().catch((err) => {
        console.error('[player] tela cheia negada pelo navegador:', err);
      });
    } else if (shell.webkitRequestFullscreen) {
      shell.webkitRequestFullscreen(); // Safari antigo
    }
  }

  btnTelaCheia.addEventListener('click', alternarTelaCheia);
  document.addEventListener('fullscreenchange', () => {
    btnTelaCheia.textContent = document.fullscreenElement ? 'Sair da tela cheia' : 'Tela cheia';
  });

  // Clique duplo no vídeo alterna a tela cheia (o atalho nativo se perdeu
  // junto com o controlslist="nofullscreen"). A faixa final é ignorada:
  // dois cliques rápidos na barra de controles (volume, seek) não devem
  // jogar o player em fullscreen.
  video.addEventListener('dblclick', (e) => {
    if (e.offsetY > video.clientHeight - 64) return;
    alternarTelaCheia();
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

// Equalizador via Web Audio API, ligado/desligado pelo interruptor ao lado
// do texto "Equalizador de áudio". createMediaElementSource é permanente
// (não existe "desfazer" — todo o áudio do <video> passa a sair pelo grafo),
// então desligar não desmonta nada: o source é religado direto no destino,
// num bypass real que tira compressor e filtros do caminho do som.
// O AudioContext só pode ser criado/retomado a partir de um gesto do usuário
// (política de autoplay), por isso o grafo é montado preguiçosamente.
// Estado (ligado + ganhos por banda) persiste no localStorage do navegador.
function configurarEqualizador(video) {
  const toggleEq = document.getElementById('toggle-equalizador');
  const painelEq = document.getElementById('painel-equalizador');

  const BANDAS_HZ = [60, 170, 350, 1000, 3500, 10000];
  const CHAVE_STORAGE = 'sspwi-equalizador';

  let audioCtx = null;
  let source = null;
  let entradaCadeia = null; // primeiro nó da cadeia (compressor) — alvo do religa
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

  function montarGrafoDeAudio() {
    if (audioCtx) return;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    source = audioCtx.createMediaElementSource(video);

    // Nivelamento automático de volume (trecho muito alto abaixa um pouco,
    // trecho muito baixo sobe um pouco). Isso é dinâmica de AMPLITUDE — não
    // tem relação com as bandas de frequência, que aplicam os ganhos salvos.
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

    entradaCadeia = compressor;
    compressor.connect(ganhoCompensacao);

    let node = ganhoCompensacao;
    BANDAS_HZ.forEach((freq, i) => {
      const filtro = audioCtx.createBiquadFilter();
      filtro.type = 'peaking';
      filtro.frequency.value = freq;
      filtro.Q.value = 1;
      filtro.gain.value = estado.ganhos[i];
      node.connect(filtro);
      node = filtro;
      filtros[i] = filtro;
    });
    node.connect(audioCtx.destination);
  }

  function ligar() {
    montarGrafoDeAudio();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    source.disconnect();
    source.connect(entradaCadeia);
    painelEq.hidden = false;
  }

  function desligar() {
    // Bypass: som segue direto pro destino, sem compressor nem filtros.
    // (Se o grafo nunca foi montado, o áudio nem saiu do caminho nativo.)
    if (source) {
      source.disconnect();
      source.connect(audioCtx.destination);
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
      if (toggleEq.checked && !audioCtx) ligar();
    };
    document.addEventListener('pointerdown', engatar, { once: true });
    document.addEventListener('keydown', engatar, { once: true });
  }
}
