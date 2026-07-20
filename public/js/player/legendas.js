// Botão de engrenagem: abre/fecha o painel e liga o seletor de legenda.
// Legenda é extraída à parte via /media/subtitle (operação leve, com cache),
// mas NÃO entra como <track> nativa: o navegador cria sozinho um botão "CC"
// na barra de controles quando existe uma faixa de texto, e não há CSS
// confiável pra escondê-lo no Chrome. Em vez disso o próprio player baixa o
// WebVTT, interpreta as cues e desenha a legenda numa camada sobre o vídeo
// (.legenda-overlay) — mesma função, barra limpa. Trocar de legenda continua
// sem interromper o vídeo que já está tocando.
export function configurarPainelConfiguracoes({ arquivo, video }) {
  const btnConfig = document.getElementById('btn-config');
  const painel = document.getElementById('painel-config');
  const selectLegenda = document.getElementById('select-legenda');
  const overlay = document.getElementById('legenda-overlay');

  btnConfig.addEventListener('click', () => {
    const estaAberto = !painel.hidden;
    painel.hidden = estaAberto;
    btnConfig.setAttribute('aria-expanded', String(!estaAberto));
  });

  // Clicar FORA do painel (e fora da engrenagem) fecha o painel. Só age com
  // ele aberto; cliques dentro dele (selects, sliders, botões) não fecham,
  // e clicar na própria engrenagem cai no handler acima (que alterna) — o
  // guard de btnConfig.contains evita o painel abrir e fechar no mesmo clique.
  document.addEventListener('click', (e) => {
    if (painel.hidden) return;
    if (painel.contains(e.target) || btnConfig.contains(e.target)) return;
    painel.hidden = true;
    btnConfig.setAttribute('aria-expanded', 'false');
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
