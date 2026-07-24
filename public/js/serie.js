// Página da série/coleção: lista ordenada de episódios de um grupo. O id do
// grupo (pasta de nível 1) vem na URL como ?grupo=... Cada episódio abre no
// player COM o parâmetro grupo — é isso que deixa o player resolver o
// "próximo episódio" (auto-play). Ver player/serie.js.
const { Auth } = window;

const params = new URLSearchParams(window.location.search);
const grupoId = params.get('grupo');
// Título vindo do catálogo: mostra algo na hora, antes do fetch responder.
const tituloInicial = params.get('titulo') || '';

const elTitulo = document.getElementById('serie-titulo');
const elContagem = document.getElementById('serie-contagem');
const elCapa = document.getElementById('serie-capa');
const elLista = document.getElementById('serie-lista');

document.title = tituloInicial ? `${tituloInicial} — Sala de projeção` : 'Série — Sala de projeção';
elTitulo.textContent = tituloInicial;

function mostrarErro(msg) {
  elLista.innerHTML = '';
  const li = document.createElement('li');
  li.className = 'serie-vazio';
  li.textContent = msg;
  elLista.appendChild(li);
}

// Monta uma linha da lista de episódios. DOM + textContent (nomes vêm de
// disco — conteúdo arbitrário; nunca innerHTML com interpolação).
function criarLinha(item, indice) {
  const li = document.createElement('li');
  li.className = 'serie-item';
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  li.setAttribute('aria-label', `Assistir ${item.titulo}`);

  const num = document.createElement('span');
  num.className = 'serie-item-num';
  num.textContent = String(indice + 1);

  const capa = document.createElement('img');
  capa.className = 'serie-item-capa';
  capa.src = item.capa || '';
  capa.alt = '';
  capa.addEventListener('error', () => { capa.style.visibility = 'hidden'; });

  const texto = document.createElement('div');
  texto.className = 'serie-item-texto';
  const t = document.createElement('span');
  t.className = 'serie-item-titulo';
  t.textContent = item.titulo;
  texto.appendChild(t);
  if (item.descricao) {
    const d = document.createElement('span');
    d.className = 'serie-item-desc';
    d.textContent = item.descricao;
    texto.appendChild(d);
  }

  const abrir = () => {
    const p = new URLSearchParams({
      arquivo: item.arquivo,
      titulo: item.titulo,
      descricao: item.descricao || '',
      grupo: grupoId,
    });
    window.location.href = `/player.html?${p.toString()}`;
  };
  li.addEventListener('click', abrir);
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(); }
  });

  li.append(num, capa, texto);
  return li;
}

async function carregar() {
  if (!grupoId) {
    window.location.href = '/';
    return;
  }
  if (!(await Auth.garantir())) {
    mostrarErro('Acesso negado pelo servidor.');
    Auth.iniciarPolling(() => window.location.reload());
    return;
  }

  try {
    const res = await fetch(`/api/serie?grupo=${encodeURIComponent(grupoId)}`, { cache: 'no-store' });
    if (res.status === 404) return mostrarErro('Série não encontrada.');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const serie = await res.json();

    elTitulo.textContent = serie.titulo || tituloInicial;
    document.title = `${serie.titulo || tituloInicial} — Sala de projeção`;
    const n = serie.total || serie.itens.length;
    elContagem.textContent = `${n} ${n === 1 ? 'episódio' : 'episódios'}`;
    if (serie.capa) { elCapa.src = serie.capa; } else { elCapa.style.display = 'none'; }
    elCapa.alt = `Capa de ${serie.titulo || ''}`;

    elLista.innerHTML = '';
    serie.itens.forEach((item, i) => elLista.appendChild(criarLinha(item, i)));
  } catch (err) {
    console.error('[serie] falha ao carregar a série:', err);
    mostrarErro('Não foi possível carregar a série.');
  }
}

carregar();
