// Utilitários HTTP compartilhados pelas rotas. sendError vivia duplicado em
// routes/media.js e routes/watchTime.js — aqui é um lugar só.
function sendError(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg);
}

module.exports = { sendError };
