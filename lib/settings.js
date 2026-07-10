const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, '..', 'config', 'settings.json');

// proxiesConfiaveis: IPs que, quando são o peer DIRETO da conexão TCP
// (não forjável), autorizam o servidor a confiar no cabeçalho
// X-Forwarded-For que eles definirem. 127.0.0.1/::1 cobre o caso comum de
// um nginx rodando na mesma máquina (veja deploy/nginx.conf.example).
const PADRAO = {
  removerFilmesAusentesDoCatalogo: true,
  proxiesConfiaveis: ['127.0.0.1', '::1'],
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
