// Preferências que SEGUEM o usuário (servidor, por uid do cookie): o volume e
// o idioma de áudio preferido. Vêm de GET /user/prefs e são salvas por
// navigator.sendBeacon (POST leve). O que é do DISPOSITIVO — equalizador,
// stats de nerd, ajuste de imagem — NÃO passa por aqui: fica no localStorage
// (ver audio.js/stats.js/tela.js). Volume é um valor só, pra todos os filmes.
export function configurarPrefsUsuario({ video, tracks, selectAudio }) {
  let prefsCarregadas = false;
  let ultimoVolumeSalvo = null;

  const salvar = (params) => {
    navigator.sendBeacon(`/user/prefs/save?${new URLSearchParams(params)}`);
  };

  // Volume: o slider dispara volumechange em rajada durante o arraste, então
  // salvamos no máximo 1x a cada 800ms, e só quando o valor mudou de verdade
  // (evita re-salvar o volume que acabamos de carregar do servidor).
  let timerVolume = null;
  video.addEventListener('volumechange', () => {
    if (!prefsCarregadas) return;
    if (ultimoVolumeSalvo !== null && Math.abs(video.volume - ultimoVolumeSalvo) < 0.001) return;
    clearTimeout(timerVolume);
    timerVolume = setTimeout(() => {
      ultimoVolumeSalvo = video.volume;
      salvar({ volume: video.volume.toFixed(3) });
    }, 800);
  });

  // Idioma de áudio: quando o usuário troca de faixa, guarda o idioma dela
  // (não o índice — índices variam por filme). Faixa sem idioma real ('und')
  // não vira preferência. Ignorado durante a auto-seleção nossa (abaixo).
  let selecionandoProgramatico = false;
  if (selectAudio) {
    selectAudio.addEventListener('change', () => {
      if (selecionandoProgramatico || !prefsCarregadas) return;
      const faixa = tracks.audio[Number(selectAudio.value)];
      if (faixa && faixa.idioma && faixa.idioma !== 'und') salvar({ audioIdioma: faixa.idioma });
    });
  }

  fetch('/user/prefs', { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : {}))
    .then((prefs) => {
      if (typeof prefs.volume === 'number') {
        video.volume = prefs.volume;
        ultimoVolumeSalvo = prefs.volume;
      }
      prefsCarregadas = true;

      // Auto-seleciona a faixa do idioma preferido, se existir, houver mais de
      // uma faixa e ela não for já a que está tocando. Dispara o mesmo 'change'
      // que a troca manual (audio.js cuida do resto).
      if (prefs.audioIdioma && selectAudio && tracks.audio.length > 1) {
        const idx = tracks.audio.findIndex((f) => (f.idioma || '').toLowerCase() === prefs.audioIdioma);
        if (idx >= 0 && String(idx) !== selectAudio.value) {
          selecionandoProgramatico = true;
          selectAudio.value = String(idx);
          selectAudio.dispatchEvent(new Event('change'));
          selecionandoProgramatico = false;
        }
      }
    })
    .catch(() => {
      // Sem prefs (offline, 401...) — o player segue com os padrões.
      prefsCarregadas = true;
    });
}
