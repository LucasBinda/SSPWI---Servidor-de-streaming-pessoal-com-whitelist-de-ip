const fs = require('fs');
const path = require('path');
const { ipEstaAutorizado } = require('./ipMatch');
const { loadSettings } = require('../lib/settings');
const { sessaoDaRequisicao } = require('../lib/sessionToken');
const { salvarJson } = require('../lib/jsonStore');

const WHITELIST_PATH = path.join(__dirname, '..', 'config', 'whitelist.json');

// Lê o arquivo a cada requisição de propósito: assim dá pra editar
// a whitelist.json e aplicar na hora, sem reiniciar o servidor.
//
// Duas listas convivem no arquivo:
// - allowedIps: a lista MANUAL, editada só por você — nunca tocamos nela.
// - autoAllowedIps: entradas [{ip, usuario, expiraEm}] adicionadas
//   automaticamente quando um usuário com cookie de sessão válido aparece
//   num IP novo (trocou de rede, IPv6 rotativo etc). Expiram junto com a
//   sessão e são renovadas com o uso — e podadas na leitura, então a lista
//   não acumula lixo.
function loadWhitelist() {
  const raw = fs.readFileSync(WHITELIST_PATH, 'utf-8');
  const dados = JSON.parse(raw);
  return {
    allowedIps: Array.isArray(dados.allowedIps) ? dados.allowedIps : [],
    autoAllowedIps: Array.isArray(dados.autoAllowedIps) ? dados.autoAllowedIps : [],
  };
}

// Escrita atômica (tmp+rename): a whitelist é reescrita a cada
// auto-autorização de IP. Um writeFileSync interrompido a corromperia, e aí
// TODA leitura seguinte lançaria — negando acesso a todo mundo (500) até
// alguém consertar o arquivo à mão. A leitura (loadWhitelist) continua
// lançando de propósito: arquivo ausente/inválido deve NEGAR (fail-closed),
// não abrir com lista vazia silenciosa.
function salvarWhitelist(dados) {
  salvarJson(WHITELIST_PATH, dados);
}

// Matricula (ou renova) o IP atual na lista automática, com expiração
// acompanhando a da sessão que o autorizou. Poda entradas vencidas no
// mesmo passo — a lista se mantém do tamanho do nº de usuários ativos.
function autoAutorizarIp(ip, sessao) {
  const dados = loadWhitelist();
  const agora = Date.now();

  const vivas = dados.autoAllowedIps.filter((entrada) => entrada.expiraEm > agora);
  const existente = vivas.find((entrada) => entrada.ip === ip);
  if (existente) {
    existente.usuario = sessao.uid;
    existente.expiraEm = sessao.exp;
  } else {
    vivas.push({ ip, usuario: sessao.uid, expiraEm: sessao.exp });
    console.log(`[WHITELIST AUTO] IP ${ip} autorizado pela sessão do usuário ${sessao.uid} (expira ${new Date(sessao.exp).toISOString()})`);
  }

  dados.autoAllowedIps = vivas;
  try {
    salvarWhitelist(dados);
  } catch (err) {
    console.error('[WHITELIST AUTO] falha ao salvar config/whitelist.json:', err.message);
  }
}

// Varredura periódica (server.js: boot + intervalo): remove do
// whitelist.json as entradas automáticas vencidas. Elas já NÃO davam
// acesso (toda checagem exige expiraEm > agora), mas ficavam gravadas no
// arquivo — par IP+usuário de sessões mortas — até o próximo evento de
// auto-autorização, que podia nunca acontecer. Cookie morto => rastro
// some do arquivo na varredura seguinte.
function podarAutoIpsExpirados() {
  let dados;
  try {
    dados = loadWhitelist();
  } catch {
    return;
  }
  const agora = Date.now();
  const vivas = dados.autoAllowedIps.filter((entrada) => entrada.expiraEm > agora);
  if (vivas.length === dados.autoAllowedIps.length) return;

  dados.autoAllowedIps = vivas;
  try {
    salvarWhitelist(dados);
    console.log('[WHITELIST AUTO] entradas expiradas removidas de config/whitelist.json');
  } catch (err) {
    console.error('[WHITELIST AUTO] falha ao podar expirados:', err.message);
  }
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
//
// Ordem de decisão:
// 1. IP na lista manual (allowedIps) -> passa.
// 2. IP na lista automática (autoAllowedIps) e não expirado -> passa.
// 3. IP desconhecido MAS cookie de sessão válido -> o usuário trocou de
//    IP com um login ainda vivo: matricula o IP novo na lista automática
//    e passa. É isso que faz o login sobreviver a troca de rede.
// 4. Nada disso -> 403 (e a linha [ACESSO BLOQUEADO] no log, que o polling
//    de 20s do front-end alimenta de propósito).
function checarWhitelist(req, res) {
  let whitelist;
  try {
    whitelist = loadWhitelist();
  } catch (err) {
    console.error('Falha ao ler config/whitelist.json:', err.message);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Erro de configuração do servidor.');
    return false;
  }

  const settings = loadSettings();
  const clientIp = getClientIp(req, settings.proxiesConfiaveis);

  if (ipEstaAutorizado(clientIp, whitelist.allowedIps)) {
    return true;
  }

  const agora = Date.now();
  const autoVigente = whitelist.autoAllowedIps.some(
    (entrada) => entrada.ip === clientIp && entrada.expiraEm > agora
  );
  if (autoVigente) {
    return true;
  }

  const sessao = sessaoDaRequisicao(req);
  if (sessao.valido) {
    autoAutorizarIp(clientIp, sessao.dados);
    return true;
  }

  console.warn(`[ACESSO BLOQUEADO] IP não autorizado: ${clientIp} -> ${req.method} ${req.url}`);
  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Acesso negado. Seu IP não está autorizado a acessar este serviço.');
  return false;
}

module.exports = checarWhitelist;
// O middleware de sessão (sessionCookie.js) precisa enxergar EXATAMENTE o
// mesmo IP que a whitelist — mesma lógica de proxy confiável — pra vincular
// o token ao IP sem divergência entre as duas camadas.
module.exports.getClientIp = getClientIp;
module.exports.podarAutoIpsExpirados = podarAutoIpsExpirados;
