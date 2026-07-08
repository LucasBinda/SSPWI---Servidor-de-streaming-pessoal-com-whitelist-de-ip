const net = require('net');

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octeto) => (acc << 8) + parseInt(octeto, 10), 0) >>> 0;
}

// Expande a forma abreviada (::) de um IPv6 para um BigInt de 128 bits,
// para dar pra comparar prefixos com operações de bit.
function ipv6ToBigInt(ip) {
  let partes;
  if (ip.includes('::')) {
    const [head, tail] = ip.split('::');
    const headPartes = head ? head.split(':') : [];
    const tailPartes = tail ? tail.split(':') : [];
    const faltando = 8 - (headPartes.length + tailPartes.length);
    partes = [...headPartes, ...Array(Math.max(faltando, 0)).fill('0'), ...tailPartes];
  } else {
    partes = ip.split(':');
  }
  return partes.reduce((acc, grupo) => (acc << 16n) + BigInt(parseInt(grupo || '0', 16)), 0n);
}

// Aceita tanto um IP exato ("192.168.0.10") quanto uma faixa CIDR
// ("192.168.0.0/24" ou "2804:14d::/48") na whitelist.
function ipCorresponde(ip, entrada) {
  if (!entrada.includes('/')) {
    return ip === entrada;
  }

  const [faixa, prefixoStr] = entrada.split('/');
  const prefixo = parseInt(prefixoStr, 10);
  const versaoIp = net.isIP(ip);
  const versaoFaixa = net.isIP(faixa);

  if (versaoIp === 0 || versaoIp !== versaoFaixa) {
    return false;
  }

  if (versaoIp === 4) {
    const mascara = prefixo === 0 ? 0 : (~0 << (32 - prefixo)) >>> 0;
    return (ipv4ToInt(ip) & mascara) === (ipv4ToInt(faixa) & mascara);
  }

  // IPv6
  const mascara = prefixo === 0 ? 0n : (~0n << BigInt(128 - prefixo)) & ((1n << 128n) - 1n);
  return (ipv6ToBigInt(ip) & mascara) === (ipv6ToBigInt(faixa) & mascara);
}

function ipEstaAutorizado(ip, listaPermitida) {
  return listaPermitida.some((entrada) => ipCorresponde(ip, entrada));
}

module.exports = { ipEstaAutorizado };
