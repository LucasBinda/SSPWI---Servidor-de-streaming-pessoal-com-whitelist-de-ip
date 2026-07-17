
function mostrarBloqueado(container) {
  container.innerHTML = `
    <div class="empty-state">
      Acesso negado pelo servidor.<br>
      &hellip;
    </div>`;
  Auth.iniciarPolling(() => window.location.reload());
}

async function carregarCatalogo() {
  const container = document.getElementById('catalogo');

  // Fase 3: garante a sessão (token+cookie) antes de pedir o catálogo —
  // /api/movies e /covers/ exigem cookie válido. Se o servidor barrar,
  // entra no polling de 20s até o acesso voltar.
  if (!(await Auth.garantir())) {
    return mostrarBloqueado(container);
  }

  try {
    const res = await fetch('/api/movies');
    if (res.status === 401 || res.status === 403) return mostrarBloqueado(container);
    if (!res.ok) throw new Error('Falha ao buscar catálogo');
    const filmes = await res.json();

    if (!filmes.length) {
      container.innerHTML = `
        <div class="empty-state">
          Nenhum filme cadastrado ainda.<br>
          Adicione arquivos em <code>media/movies/</code> e edite <code>data/catalog.json</code>.
        </div>`;
      return;
    }

    filmes.forEach((filme) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `Assistir ${filme.titulo}`);

      card.innerHTML = `
        <div class="card-sprockets" aria-hidden="true">
          <span></span><span></span><span></span><span></span><span></span><span></span>
        </div>
        <img src="${filme.capa}" alt="Capa de ${filme.titulo}" onerror="this.style.display='none'">
        <div class="card-body">
          <h3>${filme.titulo}</h3>
          <p>${filme.descricao || ''}</p>
        </div>
      `;

      const abrir = () => {
        const params = new URLSearchParams({
          arquivo: filme.arquivo,
          titulo: filme.titulo,
          descricao: filme.descricao || '',
        });
        window.location.href = `/player.html?${params.toString()}`;
      };

      card.addEventListener('click', abrir);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') abrir();
      });

      container.appendChild(card);
    });
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Não foi possível carregar o catálogo.</div>`;
    console.error(err);
  }
}

carregarCatalogo();
