const https = require('https');
const os = require('os');
const { loadSettings } = require('./settings');
const { logManager } = require('./logManager');

// Atualizador de DNS dinâmico do DuckDNS (https://www.duckdns.org), embutido
// no servidor — o elo que faltava pro HTTPS da casa: o Let's Encrypt exige um
// DOMÍNIO (não emite certificado pra IP puro no fluxo normal), o DuckDNS dá
// um subdomínio gratuito (seunome.duckdns.org), e alguém precisa re-apontar
// esse domínio pro IP da casa sempre que a operadora trocar o IP. Este módulo
// faz isso de dentro do próprio servidor: sem cron, sem cliente externo, só o
// https nativo (zero dependência, como todo o resto). Guia completo do HTTPS:
// docs/https-duckdns.md.
//
// Configuração em config/settings.json (relida a cada ciclo — aplica sem
// reiniciar, como as demais):
//   duckdnsDominio: "seunome" (ou "seunome.duckdns.org", tanto faz)
//   duckdnsToken:   o token da sua conta DuckDNS (SEGREDO — settings.json
//                   fica fora do git justamente por causa dele)
// Os dois vazios (padrão) = atualizador dormente, custo zero.
//
// A API do DuckDNS é um GET em /update com:
//   ip= VAZIO  -> o DuckDNS usa o IP de onde o pedido veio. A requisição é
//                 forçada a sair por IPv4 (family: 4), então esse "IP de
//                 origem" é o IPv4 público da casa — exatamente o que o
//                 registro A precisa (é ele que atravessa o NAT do roteador).
//   ipv6=      -> preenchido com o endereço global DESTA máquina, quando
//                 existir. IPv6 não tem NAT: o AAAA aponta direto pro
//                 servidor, não pro roteador.
// Resposta com verbose=true: "OK\n<ip>\n<ipv6>\nUPDATED|NOCHANGE", ou "KO"
// (domínio/token recusados).

// Cadência recomendada pelo próprio DuckDNS. O intervalo roda com unref()
// pra nunca segurar o processo vivo sozinho.
const INTERVALO_MS = 5 * 60 * 1000;

// "SeuNome.duckdns.org" -> "seunome" (a API espera só o subdomínio).
function normalizarDominio(dominio) {
  return String(dominio || '').trim().toLowerCase().replace(/\.duckdns\.org$/, '');
}

// Endereço IPv6 global desta máquina (fora link-local fe80 e loopback), ou
// null — mesma seleção que o server.js usa pra imprimir o endereço no boot.
function ipv6Global() {
  const interfaces = Object.values(os.networkInterfaces()).flat();
  const achado = interfaces.find(
    (i) => i && !i.internal && i.family === 'IPv6' && !i.address.startsWith('fe80')
  );
  return achado ? achado.address : null;
}

function montarUrlAtualizacao(dominio, token, ipv6) {
  const url = new URL('https://www.duckdns.org/update');
  url.searchParams.set('domains', normalizarDominio(dominio));
  url.searchParams.set('token', token);
  url.searchParams.set('ip', ''); // vazio de propósito: autodetecção (ver topo)
  if (ipv6) url.searchParams.set('ipv6', ipv6);
  url.searchParams.set('verbose', 'true');
  return url.toString();
}

// Um aponte no DuckDNS. Nunca rejeita — resolve { ok, mudou, ips } no
// sucesso ou { ok: false, erro } em qualquer falha (rede, timeout, KO).
function atualizarDuckdns(dominio, token) {
  return new Promise((resolve) => {
    const url = montarUrlAtualizacao(dominio, token, ipv6Global());
    const req = https.get(url, { family: 4, timeout: 15000 }, (res) => {
      let corpo = '';
      res.on('data', (chunk) => { corpo += chunk; });
      res.on('end', () => {
        const linhas = corpo.trim().split('\n');
        if (linhas[0] !== 'OK') {
          return resolve({ ok: false, erro: 'domínio ou token recusados pelo DuckDNS (resposta KO)' });
        }
        resolve({
          ok: true,
          mudou: linhas[linhas.length - 1] === 'UPDATED',
          ips: linhas.slice(1, -1).filter(Boolean).join(' / ') || '(ip não informado)',
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout de 15s')));
    req.on('error', (err) => resolve({ ok: false, erro: err.message }));
  });
}

// Log com dedup por mudança de estado: um IP que não muda a cada 5min não
// gera linha nenhuma; erro repetido loga uma vez só; recuperação loga.
// O token NUNCA aparece em log — só o domínio e os IPs.
let estadoAnterior = '';

function ciclo() {
  const { duckdnsDominio, duckdnsToken } = loadSettings();
  if (!duckdnsDominio || !duckdnsToken) return; // não configurado = dormente

  const nome = `${normalizarDominio(duckdnsDominio)}.duckdns.org`;
  atualizarDuckdns(duckdnsDominio, duckdnsToken).then((resultado) => {
    if (!resultado.ok) {
      const estado = `erro: ${resultado.erro}`;
      if (estado !== estadoAnterior) {
        logManager.registrarErro('duckdns', `falha ao atualizar ${nome}: ${resultado.erro}`);
      }
      estadoAnterior = estado;
      return;
    }
    if (resultado.mudou || estadoAnterior.startsWith('erro')) {
      logManager.info('duckdns', `${nome} -> ${resultado.ips}`);
    }
    estadoAnterior = 'ok';
  });
}

// Chamado uma vez no boot (server.js): dispara o primeiro aponte e agenda os
// seguintes. Se settings.json ganhar domínio+token depois, os ciclos passam a
// agir sozinhos — sem reiniciar o servidor.
function iniciarAtualizadorDuckdns() {
  const { duckdnsDominio, duckdnsToken } = loadSettings();
  if (duckdnsDominio && duckdnsToken) {
    logManager.info('duckdns', `DNS dinâmico ativo para ${normalizarDominio(duckdnsDominio)}.duckdns.org (aponte a cada 5min)`);
  }
  ciclo();
  setInterval(ciclo, INTERVALO_MS).unref();
}

module.exports = { iniciarAtualizadorDuckdns, atualizarDuckdns, montarUrlAtualizacao, normalizarDominio };
