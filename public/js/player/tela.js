// A engrenagem acompanha a barra de controles nativa: some depois de ~3s sem
// atividade com o vídeo tocando (mesmo timeout do Chrome) pra não ficar na
// frente do filme, e reaparece ao mexer o mouse ou tocar na tela. Nunca some
// com o vídeo pausado (a barra nativa também não some) nem com o painel de
// configurações aberto.
export function configurarOcultarConfigOcioso(video) {
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
export function configurarModosDeTela(video) {
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

// Ajuste de imagem quando o filme ocupa a tela (modo retrato/tela cheia):
// Original mantém a imagem fiel (bordas pretas se a proporção não bater),
// Preencher amplia cortando as beiradas e Esticar deforma até ocupar tudo.
// No layout normal da página não tem efeito — ali a altura do player já
// acompanha a proporção do arquivo. A escolha persiste no localStorage.
export function configurarAjusteDeImagem() {
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
