const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, '..', 'config', 'settings.json');

// proxiesConfiaveis: IPs que, quando são o peer DIRETO da conexão TCP
// (não forjável), autorizam o servidor a confiar no cabeçalho
// X-Forwarded-For que eles definirem. 127.0.0.1/::1 cobre o caso comum de
// um nginx rodando na mesma máquina (veja deploy/nginx.conf.example).
// reencode*: fase 2 (padronização de armazenamento). reencodeAtivo liga o
// worker que converte não-mp4 pra mp4 em background; codec/preset/crf só
// valem quando o vídeo de origem precisa de re-encode de verdade (fontes
// já em HEVC/AV1 são copiadas sem re-encodar, ver lib/reencodeWorker.js).
// trocarCapasAutoNoCatalogo: quando true, toda chamada do catálogo
// (/api/movies) sorteia um frame NOVO pra cada capa gerada automaticamente
// — as capas ficam "vivas", mudando a cada visita. Capas definidas à mão
// pelo usuário nunca são tocadas. Padrão false (a capa sorteada na
// primeira vez fica fixa).
const PADRAO = {
  removerFilmesAusentesDoCatalogo: true,
  proxiesConfiaveis: ['127.0.0.1', '::1'],
  reencodeAtivo: true,
  reencodeCodec: 'libx265',
  reencodePreset: 'fast',
  reencodeCrf: 26,
  trocarCapasAutoNoCatalogo: false,
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
