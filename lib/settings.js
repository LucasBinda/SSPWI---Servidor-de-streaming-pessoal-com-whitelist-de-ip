const fs = require('fs');
const { SETTINGS_PATH } = require('./paths');

// proxiesConfiaveis: IPs que, quando são o peer DIRETO da conexão TCP
// (não forjável), autorizam o servidor a confiar no cabeçalho
// X-Forwarded-For que eles definirem. 127.0.0.1/::1 cobre o caso comum de
// um nginx rodando na mesma máquina (veja deploy/nginx.conf.example).
// reencode*: fase 2 (padronização de armazenamento). reencodeAtivo liga o
// worker que converte não-mp4 pra mp4 em background; codec/preset/crf só
// valem quando o vídeo de origem precisa de re-encode de verdade (fontes
// já em HEVC/AV1 são copiadas sem re-encodar, ver lib/reencodeWorker.js).
// Quando o re-encode é inevitável, o worker decide sozinho ONDE rodar: faz
// uma prova de velocidade de até 30s por modo (o codec configurado no CPU
// e, havendo GPU NVIDIA, os modos NVENC) e converte com o mais rápido —
// sem configuração extra; ver escolherModo em lib/reencodeWorker.js.
// trocarCapasAutoNoCatalogo: quando true, toda chamada do catálogo
// (/api/movies) sorteia um frame NOVO pra cada capa gerada automaticamente
// — as capas ficam "vivas", mudando a cada visita. Capas definidas à mão
// pelo usuário nunca são tocadas. Padrão false (a capa sorteada na
// primeira vez fica fixa).
// duckdns*: DNS dinâmico gratuito, pré-requisito do HTTPS via proxy reverso
// (guia completo em docs/https-duckdns.md). Preencha duckdnsDominio
// ("seunome" ou "seunome.duckdns.org") e duckdnsToken (da sua conta em
// duckdns.org) e o próprio servidor re-aponta o domínio pro IP da casa a
// cada 5min (lib/duckdns.js). Vazios = desligado. O token é SEGREDO — por
// causa dele o settings.json real fica fora do git (só o .example.json é
// versionado, mesmo esquema da whitelist).
// atrasDeProxyTls: ligue quando o acesso passar pelo nginx com HTTPS —
// adiciona a flag Secure ao cookie de sessão (o navegador só o envia
// criptografado). Ligar SEM HTTPS quebra o login (o cookie nunca chega).
const PADRAO = {
  removerFilmesAusentesDoCatalogo: true,
  proxiesConfiaveis: ['127.0.0.1', '::1'],
  reencodeAtivo: true,
  reencodeCodec: 'libx265',
  reencodePreset: 'fast',
  reencodeCrf: 26,
  trocarCapasAutoNoCatalogo: false,
  duckdnsDominio: '',
  duckdnsToken: '',
  atrasDeProxyTls: false,
};

// Lê config/settings.json a cada chamada (dá pra editar e aplicar na hora,
// sem reiniciar o servidor). Qualquer campo ausente no arquivo (ou o
// arquivo inteiro ausente) cai no padrão acima.
function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const config = JSON.parse(raw);
    return { ...PADRAO, ...config };
  } catch (err) {
    return { ...PADRAO };
  }
}

module.exports = { loadSettings };
