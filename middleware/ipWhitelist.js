const fs = require('fs');
const path = require('path');
const { ipEstaAutorizado } = require('./ipMatch');

const WHITELIST_PATH = path.join(__dirname, '..', 'config', 'whitelist.json');

// Lê o arquivo a cada requisição de propósito: assim dá pra editar
// a whitelist.json e aplicar na hora, sem reiniciar o servidor.
function loadAllowedIps() {
  const raw = fs.readFileSync(WHITELIST_PATH, 'utf-8');
  return JSON.parse(raw).allowedIps;
}

function getClientIp(req) {
  // Se o servidor estiver atrás de um proxy reverso (nginx, Caddy),
  // o IP real do cliente vem no cabeçalho X-Forwarded-For.
  const forwarded = req.headers['x-forwarded-for'];
  const rawIp = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
  // Remove o prefixo IPv4-mapped-IPv6 (::ffff:) que o Node adiciona às vezes.
  return (rawIp || '').replace('::ffff:', '');
}

// Retorna true se a requisição pode seguir em frente. Se retornar false,
// já escreveu a resposta 403 (ou 500) sozinha — quem chamou só precisa
// parar de processar a requisição nesse ponto.
function checarWhitelist(req, res) {
  let allowedIps;
  try {
    allowedIps = loadAllowedIps();
  } catch (err) {
    console.error('Falha ao ler config/whitelist.json:', err.message);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Erro de configuração do servidor.');
    return false;
  }

  const clientIp = getClientIp(req);

  if (ipEstaAutorizado(clientIp, allowedIps)) {
    return true;
  }

  console.warn(`[ACESSO BLOQUEADO] IP não autorizado: ${clientIp} -> ${req.method} ${req.url}`);
  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Acesso negado. Seu IP não está autorizado a acessar este serviço.');
  return false;
}

module.exports = checarWhitelist;
