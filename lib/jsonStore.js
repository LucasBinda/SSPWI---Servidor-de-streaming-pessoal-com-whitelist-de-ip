const fs = require('fs');

// Leitura e escrita dos "bancos de dados" JSON do projeto (catalog.json,
// watchtime.json, whitelist.json, reencode-state.json) — o padrão de
// persistência deste servidor zero-dependência.
//
// A escrita é ATÔMICA: grava num arquivo temporário e faz rename por cima do
// definitivo. O rename é atômico no mesmo file system, então um crash ou
// queda de energia no meio da escrita nunca deixa o JSON pela metade — ou o
// arquivo é a versão antiga inteira, ou a nova inteira. Sem isso, um
// writeFileSync interrompido corrompia o catalog.json, o parse seguinte
// falhava, a lista virava [] e o sincronizador regenerava tudo do zero,
// perdendo títulos/descrições/capas preenchidos à mão. É o mesmo tmp+rename
// que reencodeWorker/coverPicker/mediaTools já usavam pros artefatos de
// mídia — aqui centralizado pros JSONs.

// Lê e faz JSON.parse de um arquivo. Qualquer falha (arquivo ausente, JSON
// inválido) devolve o padrão informado — nunca lança. `validar`, se passado,
// recebe o valor lido e deve devolver true pra ele ser aceito (senão, cai no
// padrão) — serve pra garantir "é um array", "é um objeto", etc.
function lerJson(caminho, padrao, validar) {
  try {
    const valor = JSON.parse(fs.readFileSync(caminho, 'utf-8'));
    if (validar && !validar(valor)) return padrao;
    return valor;
  } catch {
    return padrao;
  }
}

// Grava `dados` como JSON indentado, de forma atômica. Lança em erro de
// disco — o chamador decide se loga e segue (a maioria só quer avisar no
// console sem derrubar a requisição).
function salvarJson(caminho, dados) {
  const tmp = `${caminho}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(dados, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, caminho);
}

module.exports = { lerJson, salvarJson };
