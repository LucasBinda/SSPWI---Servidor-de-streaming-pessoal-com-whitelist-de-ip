const fs = require('fs');
const path = require('path');
const { ipEstaAutorizado } = require('./ipMatch');
const { loadSettings } = require('../lib/settings');

const WHITELIST_PATH = path.join(__dirname, '..', 'config', 'whitelist.json');

// Lê o arquivo a cada requisição de propósito: assim dá pra editar
// a whitelist.json e aplicar na hora, sem reiniciar o servidor.
function loadAllowedIps() {
  const raw = fs.readFileSync(WHITELIST_PATH, 'utf-8');
  return JSON.parse(raw).allowedIps;
}

function normalizarIp(ip) {
  // Remove o prefixo IPv4-mapped-IPv6 (::ffff:) que o Node adiciona às vezes.
  return (ip || '').replace('::ffff:', '');
}

// Descobre o IP "de verdade" do cliente.
//
// IMPORTANTE (correção de uma vulnerabilidade real): X-Forwarded-For é um
// cabeçalho que QUALQUER cliente HTTP pode definir com o valor que quiser
// — ele não é, por si só, prova de nada. O único dado não-forjável aqui é
// req.socket.remoteAddress (o IP da conexão TCP real).
//
// Por isso, só confiamos em X-Forwarded-For quando o peer DIRETO da conexão
// (req.socket.remoteAddress) já é, ele mesmo, um proxy conhecido e confiável
// (config/settings.json -> proxiesConfiaveis, ex: 127.0.0.1 se você rodar
// nginx na mesma máquina, veja deploy/nginx.conf.example). Se a conexão
// direta não vier de um proxy confiável, o cabeçalho é ignorado por
// completo e usamos só o IP real da conexão.
//
// Quando confiamos no cabeçalho, usamos o ÚLTIMO valor da lista (separada
// por vírgulas), não o primeiro: a convenção do X-Forwarded-For é cada
// proxy ACRESCENTAR o IP que ele observou no final da lista — o último
// valor é o que o SEU proxy confiável realmente viu como peer direto dele;
// o primeiro valor é o que a requisição original alegou, e pode ter sido
// forjado por quem a originou.
function getClientIp(req, proxiesConfiaveis) {
  const socketIp = normalizarIp(req.socket.remoteAddress);
  const forwarded = req.headers['x-forwarded-for'];

  if (forwarded && ipEstaAutorizado(socketIp, proxiesConfiaveis)) {
    const partes = forwarded.split(',').map((p) => p.trim()).filter(Boolean);
    const ultimoIp = partes[partes.length - 1];
    if (ultimoIp) {
      return normalizarIp(ultimoIp);
    }
  }

  return socketIp;
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

  const settings = loadSettings();
  const clientIp = getClientIp(req, settings.proxiesConfiaveis);

  if (ipEstaAutorizado(clientIp, allowedIps)) {
    return true;
  }

  console.warn(`[ACESSO BLOQUEADO] IP não autorizado: ${clientIp} -> ${req.method} ${req.url}`);
  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Acesso negado. Seu IP não está autorizado a acessar este serviço.');
  return false;
}

module.exports = checarWhitelist;
