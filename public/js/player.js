// Orquestrador do player: lê os parâmetros da URL, garante a sessão e monta
// os módulos de comportamento. Cada configurar* mora no seu próprio arquivo
// em js/player/ (legendas, tela, áudio, watch time) — aqui só se costura tudo.
import { configurarPainelConfiguracoes } from './player/legendas.js';
import {
  configurarOcultarConfigOcioso,
  configurarModosDeTela,
  configurarAjusteDeImagem,
} from './player/tela.js';
import { preencherFaixas, configurarEqualizador } from './player/audio.js';
import { configurarWatchTime } from './player/watchtime.js';
import { configurarStatsNerd } from './player/stats.js';
import { configurarPrefsUsuario } from './player/prefs.js';

// Auth vem de js/auth.js (script clássico carregado ANTES deste módulo, que
// expõe window.Auth) — o cookie de sessão é HttpOnly, então este código só
// dispara as requisições, sem nunca ver o token.
const { Auth } = window;

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
    .then((tracks) => {
      preencherFaixas(tracks, video, arquivo);
      configurarStatsNerd(tracks, video, arquivo);
      // Preferências de usuário (volume + idioma de áudio) entram DEPOIS do
      // preencherFaixas — precisam do seletor de áudio já montado pra
      // auto-selecionar a faixa do idioma preferido.
      configurarPrefsUsuario({ video, tracks, selectAudio: document.getElementById('select-audio') });
    })
    .catch((err) => console.error('[player] falha ao carregar metadados do vídeo:', err));
}
