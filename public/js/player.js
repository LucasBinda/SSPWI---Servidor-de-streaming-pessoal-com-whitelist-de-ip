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
  configurarAjusteDeImagem();
  configurarEqualizador(video);
  configurarWatchTime(arquivo, video);

  // Metadados (faixas de áudio/legenda) chegam em paralelo, sem bloquear o
  // início da reprodução acima.
  fetch(`/media/tracks?arquivo=${encodeURIComponent(arquivo)}`)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((tracks) => preencherFaixas(tracks, video, arquivo))
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
function preencherFaixas(tracks, video, arquivo) {
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

// Grafo de áudio COMPARTILHADO (equalizador + troca de faixa).
// createMediaElementSource só pode ser chamado UMA vez por elemento — a
// partir daí todo o áudio do <video> sai pelo grafo, então quem precisa
// mexer no som passa por aqui. A "torneira" é um nó de ganho logo depois
// da fonte: a troca de faixa fecha ela (gain 0) pra silenciar a faixa
// embutida SEM tocar em video.muted — assim a barra nativa de volume/mudo
// continua funcionando normalmente (e é espelhada na faixa externa), em
// vez de brigar com o usuário re-mutando o vídeo a cada ajuste.
let grafoAudio = null;
function obterGrafoDeAudio(video) {
  if (!grafoAudio) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaElementSource(video);
    const torneira = ctx.createGain();
    source.connect(torneira);
    torneira.connect(ctx.destination); // caminho padrão; o EQ religa quando ativo
    grafoAudio = { ctx, torneira };
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

// Ajuste de imagem quando o filme ocupa a tela (modo retrato/tela cheia):
// Original mantém a imagem fiel (bordas pretas se a proporção não bater),
// Preencher amplia cortando as beiradas e Esticar deforma até ocupar tudo.
// No layout normal da página não tem efeito — ali a altura do player já
// acompanha a proporção do arquivo. A escolha persiste no localStorage.
function configurarAjusteDeImagem() {
  const CHAVE_STORAGE = 'sspwi-ajuste-imagem';
  const AJUSTES = ['original', 'preencher', 'esticar'];
  const botoes = Array.from(document.querySelectorAll('.btn-ajuste'));

  function aplicar(ajuste) {
    document.body.classList.toggle('ajuste-preencher', ajuste === 'preencher');
    document.body.classList.toggle('ajuste-esticar', ajuste === 'esticar');
    botoes.forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.ajuste === ajuste));
    });
  }

  let salvo = localStorage.getItem(CHAVE_STORAGE);
  if (!AJUSTES.includes(salvo)) salvo = 'original';
  aplicar(salvo);

  botoes.forEach((btn) => {
    btn.addEventListener('click', () => {
      aplicar(btn.dataset.ajuste);
      localStorage.setItem(CHAVE_STORAGE, btn.dataset.ajuste);
    });
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
function configurarEqualizador(video) {
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
    const { torneira } = obterGrafoDeAudio(video);
    torneira.disconnect();
    torneira.connect(entradaCadeia);
    painelEq.hidden = false;
  }

  function desligar() {
    // Bypass real: a torneira volta a despejar direto no destino, sem
    // compressor nem filtros. (Cadeia nunca montada = nada a religar.)
    if (entradaCadeia) {
      const { ctx, torneira } = obterGrafoDeAudio(video);
      torneira.disconnect();
      torneira.connect(ctx.destination);
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
