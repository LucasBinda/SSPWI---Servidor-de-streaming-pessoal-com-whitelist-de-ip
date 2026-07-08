const fs = require('fs');
const path = require('path');

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

function ipWhitelistMiddleware(req, res, next) {
  let allowedIps;
  try {
    allowedIps = loadAllowedIps();
  } catch (err) {
    console.error('Falha ao ler config/whitelist.json:', err.message);
    return res.status(500).send('Erro de configuração do servidor.');
  }

  const clientIp = getClientIp(req);

  if (allowedIps.includes(clientIp)) {
    return next();
  }

  console.warn(`[ACESSO BLOQUEADO] IP não autorizado: ${clientIp} -> ${req.method} ${req.originalUrl}`);
  res.status(403).send('Acesso negado. Seu IP não está autorizado a acessar este serviço.');
}

module.exports = ipWhitelistMiddleware;
