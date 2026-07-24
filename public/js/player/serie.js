// Consciência de SÉRIE no player. Quando o player é aberto a partir de uma
// série (?grupo=... na URL), este módulo descobre a ORDEM dos episódios e
// resolve o "próximo". É a base do AUTO-PLAY: a lista ordenada já vem pronta
// do servidor (/api/serie), então "próximo" é só itens[i+1] — sem parsear
// temporada, sem estado no cliente.
//
// Arquitetura pensada pra crescer sobre o mesmo `proximo`:
// - hoje: link "voltar à série", botão "Próximo episódio" e auto-avanço no fim.
// - depois, sem reescrever: contagem regressiva/overlay de "a seguir", pular
//   abertura, marcar como assistido, ou desligar o auto-play por preferência.
export function configurarSerie({ video, arquivo }) {
  const params = new URLSearchParams(window.location.search);
  const grupoId = params.get('grupo');
  if (!grupoId) return; // player aberto fora de uma série — nada a fazer.

  fetch(`/api/serie?grupo=${encodeURIComponent(grupoId)}`, { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((serie) => {
      if (!serie || !Array.isArray(serie.itens)) return;
      const idx = serie.itens.findIndex((it) => it.arquivo === arquivo);
      if (idx < 0) return;
      montarControles({
        video,
        grupoId,
        serie,
        idx,
        anterior: serie.itens[idx - 1] || null,
        proximo: serie.itens[idx + 1] || null,
      });
    })
    .catch((err) => console.error('[player] falha ao carregar contexto da série:', err));
}

function irParaEpisodio(item, grupoId) {
  const p = new URLSearchParams({
    arquivo: item.arquivo,
    titulo: item.titulo,
    descricao: item.descricao || '',
    grupo: grupoId,
  });
  window.location.href = `/player.html?${p.toString()}`;
}

function montarControles({ video, grupoId, serie, idx, anterior, proximo }) {
  // Link "voltar à série" no cabeçalho (sempre que veio de uma série), com a
  // posição atual (ex.: "Legion · 3/8").
  const header = document.querySelector('.player-header');
  if (header) {
    const link = document.createElement('a');
    link.className = 'serie-link';
    link.href = `/serie.html?grupo=${encodeURIComponent(grupoId)}&titulo=${encodeURIComponent(serie.titulo)}`;
    link.textContent = `☰ ${serie.titulo} · ${idx + 1}/${serie.total}`;
    header.appendChild(link);
  }

  // Barra de navegação abaixo do vídeo: anterior à esquerda, próximo à
  // direita. Os dois são SEMPRE renderizados (layout estável — próximo nunca
  // "pula" pro lado); o inexistente nas pontas fica desabilitado.
  const nav = document.createElement('div');
  nav.className = 'serie-nav';
  nav.append(
    criarBotao('← Episódio anterior', anterior, grupoId),
    criarBotao('Próximo episódio →', proximo, grupoId),
  );
  const wrap = document.querySelector('.player-wrap');
  if (wrap) wrap.insertBefore(nav, document.getElementById('titulo-filme'));

  // AUTO-PLAY: ao terminar o episódio, avança pro próximo. Só é registrado
  // quando existe um próximo (no último episódio, nada acontece no fim).
  if (proximo) video.addEventListener('ended', () => irParaEpisodio(proximo, grupoId));
}

// Botão de navegação de episódio. Sem `alvo` (1º/último episódio), vem
// desabilitado — mantém o layout no lugar em vez de sumir e empurrar o outro.
function criarBotao(rotulo, alvo, grupoId) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-episodio';
  btn.textContent = rotulo;
  if (alvo) {
    btn.title = alvo.titulo;
    btn.addEventListener('click', () => irParaEpisodio(alvo, grupoId));
  } else {
    btn.disabled = true;
  }
  return btn;
}
