// Watch time: retoma o filme de onde o usuário parou e vai salvando a
// minutagem enquanto assiste. Toda gravação é um navigator.sendBeacon
// (POST minúsculo, parâmetros na query, resposta 204 sem corpo) — leve o
// suficiente pra rodar a cada 15s sem pesar, e o sendBeacon sobrevive ao
// fechamento da aba, que é justamente o momento mais importante de salvar.
// A minutagem pertence ao uid do cookie de login (o servidor extrai do
// cookie — nada de identidade viajando na URL).
export function configurarWatchTime(arquivo, video) {
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
