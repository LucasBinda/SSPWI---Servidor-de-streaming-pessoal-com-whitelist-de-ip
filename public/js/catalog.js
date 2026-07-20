
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

      // Montagem via DOM (createElement + textContent), NUNCA innerHTML com
      // interpolação: título/descrição vêm do NOME DO ARQUIVO em disco e do
      // catalog.json — conteúdo arbitrário. Um filme chamado
      // "<img src=x onerror=...>.mp4" viraria injeção de script se caísse
      // num innerHTML. Só a tira de perfurações (estática) usa innerHTML.
      const sprockets = document.createElement('div');
      sprockets.className = 'card-sprockets';
      sprockets.setAttribute('aria-hidden', 'true');
      sprockets.innerHTML = '<span></span><span></span><span></span><span></span><span></span><span></span>';

      const img = document.createElement('img');
      // .src como propriedade: o navegador trata como URL, não como HTML —
      // "javascript:" e afins não viram execução, e aspas no valor não
      // quebram atributo nenhum.
      img.src = filme.capa || '';
      img.alt = `Capa de ${filme.titulo}`;
      img.addEventListener('error', () => { img.style.display = 'none'; });

      const body = document.createElement('div');
      body.className = 'card-body';
      const h3 = document.createElement('h3');
      h3.textContent = filme.titulo;
      const p = document.createElement('p');
      p.textContent = filme.descricao || '';
      body.append(h3, p);

      card.append(sprockets, img, body);

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
