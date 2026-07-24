
function mostrarBloqueado(container) {
  container.innerHTML = `
    <div class="empty-state">
      Acesso negado pelo servidor.<br>
      &hellip;
    </div>`;
  Auth.iniciarPolling(() => window.location.reload());
}

// Cria um card do catálogo. Montagem via DOM (createElement + textContent),
// NUNCA innerHTML com interpolação: título/descrição vêm do NOME DO ARQUIVO em
// disco e do catalog.json — conteúdo arbitrário. Um filme chamado
// "<img src=x onerror=...>.mp4" viraria injeção de script num innerHTML. Só a
// tira de perfurações e o badge (estáticos/numéricos) usam innerHTML/String.
function criarCard({ titulo, descricao, capa, aoAbrir, badge }) {
  const card = document.createElement('div');
  card.className = 'card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', badge ? `Abrir ${titulo}` : `Assistir ${titulo}`);

  const sprockets = document.createElement('div');
  sprockets.className = 'card-sprockets';
  sprockets.setAttribute('aria-hidden', 'true');
  sprockets.innerHTML = '<span></span><span></span><span></span><span></span><span></span><span></span>';

  const capaWrap = document.createElement('div');
  capaWrap.className = 'card-capa';

  const img = document.createElement('img');
  // .src como propriedade: o navegador trata como URL, não como HTML.
  img.src = capa || '';
  img.alt = `Capa de ${titulo}`;
  img.addEventListener('error', () => { img.style.display = 'none'; });
  capaWrap.appendChild(img);

  // Badge (ex.: "8 episódios") marca visualmente que o card é uma série.
  if (badge) {
    const b = document.createElement('span');
    b.className = 'card-badge';
    b.textContent = badge;
    capaWrap.appendChild(b);
    card.classList.add('card-serie');
  }

  const body = document.createElement('div');
  body.className = 'card-body';
  const h3 = document.createElement('h3');
  h3.textContent = titulo;
  const p = document.createElement('p');
  p.textContent = descricao || '';
  body.append(h3, p);

  card.append(sprockets, capaWrap, body);

  card.addEventListener('click', aoAbrir);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); aoAbrir(); }
  });

  return card;
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
    const entradas = await res.json();

    if (!entradas.length) {
      container.innerHTML = `
        <div class="empty-state">
          Nenhum filme cadastrado ainda.<br>
          Adicione arquivos em <code>media/movies/</code> e edite <code>data/catalog.json</code>.
        </div>`;
      return;
    }

    entradas.forEach((entrada) => {
      let card;
      if (entrada.tipo === 'serie') {
        // Card de série -> página dedicada da série (lista de episódios).
        const n = entrada.total || 0;
        card = criarCard({
          titulo: entrada.titulo,
          descricao: `${n} ${n === 1 ? 'episódio' : 'episódios'}`,
          capa: entrada.capa,
          badge: String(n),
          aoAbrir: () => {
            const params = new URLSearchParams({ grupo: entrada.id, titulo: entrada.titulo });
            window.location.href = `/serie.html?${params.toString()}`;
          },
        });
      } else {
        // Filme avulso -> direto pro player (comportamento de sempre).
        card = criarCard({
          titulo: entrada.titulo,
          descricao: entrada.descricao,
          capa: entrada.capa,
          aoAbrir: () => {
            const params = new URLSearchParams({
              arquivo: entrada.arquivo,
              titulo: entrada.titulo,
              descricao: entrada.descricao || '',
            });
            window.location.href = `/player.html?${params.toString()}`;
          },
        });
      }
      container.appendChild(card);
    });
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Não foi possível carregar o catálogo.</div>`;
    console.error(err);
  }
}

carregarCatalogo();
