const params = new URLSearchParams(window.location.search);
const arquivo = params.get('arquivo');
const titulo = params.get('titulo') || '';
const descricao = params.get('descricao') || '';

document.getElementById('titulo-filme').textContent = titulo;
document.getElementById('descricao-filme').textContent = descricao;
document.title = titulo ? `${titulo} — Sala de projeção` : 'Assistindo — Sala de projeção';

if (arquivo) {
  const video = document.getElementById('video-player');
  video.src = `/stream?arquivo=${encodeURIComponent(arquivo)}`;
} else {
  window.location.href = '/';
}
