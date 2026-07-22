const fs = require('fs');
const path = require('path');
const { LOGS_DIR } = require('./paths');

// Gerenciador de logs em arquivo (logs/*.log, fora do Git).
//
// Mesmo desenho do CoverPicker: uma classe testável/reutilizável + uma
// instância compartilhada exportada, já que o estado de deduplicação
// precisa ser único no processo. Cada categoria de log vira um arquivo
// próprio dentro de logs/:
//   conexoes.log  — quem conectou (deduplicado por IP)
//   chamadas.log  — o que pediram: catálogo, filme, legenda... (dedup ip+chamada)
//   erros.log     — erros de runtime de TODOS os módulos (antes morriam no console)
//   bloqueios.log — tentativas barradas (403 da whitelist / 401 de sessão)
//
// CONSOLE COLORIDO: no terminal, cada categoria tem uma cor — azul pra
// conexão, verde pra chamada, vermelho pra erro, amarelo pra aviso/bloqueio.
// Os códigos ANSI só entram quando a saída é um terminal de verdade
// (isTTY) — arquivo de log, pipe e journald recebem texto limpo. Dá pra
// forçar com FORCE_COLOR=1 ou desligar com NO_COLOR=1 (convenções comuns).

const CORES = {
  vermelho: '\x1b[31m',
  verde: '\x1b[32m',
  amarelo: '\x1b[33m',
  azul: '\x1b[94m', // azul "claro": o azul escuro padrão some em fundo escuro
};
const RESET = '\x1b[0m';

function usarCor(stream) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream && stream.isTTY);
}

function pintar(cor, texto, stream = process.stdout) {
  if (!usarCor(stream)) return texto;
  return `${CORES[cor] || ''}${texto}${RESET}`;
}

// Janela de deduplicação do log de conexões: o navegador abre VÁRIAS
// conexões paralelas e refaz keep-alive o tempo todo — sem isso, um único
// carregamento de página viraria meia dúzia de linhas idênticas. Dentro
// da janela, o mesmo IP só é registrado uma vez ("fulano conectou às
// 14h"). Zere pra registrar toda requisição.
const JANELA_DEDUP_MS = 30 * 60 * 1000;

// Janela de deduplicação do log de chamadas (por IP + chamada): assistir
// um filme dispara DEZENAS de range requests no /stream — dentro da
// janela, "fulano assistiu filme X" vira uma linha só, não centenas. Mais
// curta que a de conexão: recarregar o catálogo depois de alguns minutos
// é um evento novo que vale registrar.
const JANELA_DEDUP_CHAMADAS_MS = 5 * 60 * 1000;

// Guarda de memória: cada mapa de deduplicação é limpo de entradas
// velhas quando passa deste tamanho (IPv6 com privacy extensions pode
// gerar muitos IPs distintos ao longo de semanas).
const MAX_ENTRADAS_NA_MEMORIA = 1000;

class LogManager {
  constructor({ logsDir }) {
    this.logsDir = logsDir;
    this.ultimaConexao = new Map(); // ip -> timestamp do último registro
    this.ultimaChamada = new Map(); // "ip|chamada" -> timestamp
  }

  // Decide se uma chave (ip, ou ip|chamada) deve gerar linha nova, dentro
  // da janela dada — e aproveita pra limpar entradas vencidas quando o
  // mapa cresce demais. Compartilhado por todos os registros deduplicados.
  deveRegistrar(mapa, chave, janelaMs) {
    const agora = Date.now();
    const ultimo = mapa.get(chave);
    if (ultimo && agora - ultimo < janelaMs) return false;

    if (mapa.size >= MAX_ENTRADAS_NA_MEMORIA) {
      for (const [chaveVelha, quando] of mapa) {
        if (agora - quando >= janelaMs) mapa.delete(chaveVelha);
      }
    }
    mapa.set(chave, agora);
    return true;
  }

  horarioLocal() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // Anexa uma linha a logs/<arquivo>. Escrita assíncrona fire-and-forget:
  // log nunca deve atrasar uma requisição, e uma linha perdida em caso de
  // erro de disco não justifica derrubar nada — só avisa no console.
  registrar(arquivo, linha) {
    try {
      fs.mkdirSync(this.logsDir, { recursive: true });
    } catch {
      /* se nem o mkdir deu, o appendFile abaixo reporta */
    }
    fs.appendFile(path.join(this.logsDir, arquivo), `${linha}\n`, (err) => {
      if (err) console.error(`[logs] falha ao escrever ${arquivo}:`, err.message);
    });
  }

  // Registra uma conexão autorizada no formato "Horario - ip" em
  // logs/conexoes.log (deduplicada por JANELA_DEDUP_MS, ver acima).
  registrarConexao(ip) {
    if (!this.deveRegistrar(this.ultimaConexao, ip, JANELA_DEDUP_MS)) return;
    this.registrar('conexoes.log', `${this.horarioLocal()} - ${ip}`);
    console.log(pintar('azul', `[conexão] ${ip}`));
  }

  // Registra uma chamada de conteúdo do site no formato
  // "Horario - ip - chamada" em logs/chamadas.log — ex.:
  //   2026-07-18 09:12:44 - 192.168.0.10 - catálogo
  //   2026-07-18 09:13:02 - 192.168.0.10 - filme: acao/filme.mp4
  // Deduplicada por IP+chamada (JANELA_DEDUP_CHAMADAS_MS): os muitos range
  // requests de um mesmo filme viram uma linha só por sessão de exibição.
  registrarChamada(ip, chamada) {
    if (!this.deveRegistrar(this.ultimaChamada, `${ip}|${chamada}`, JANELA_DEDUP_CHAMADAS_MS)) return;
    this.registrar('chamadas.log', `${this.horarioLocal()} - ${ip} - ${chamada}`);
    console.log(pintar('verde', `[chamada] ${ip} -> ${chamada}`));
  }

  // Erro de runtime de qualquer módulo: console em vermelho E linha em
  // logs/erros.log — um erro às 3h da manhã deixa rastro em disco em vez de
  // morrer no scroll do terminal. "origem" é o prefixo curto de sempre
  // (reencode, media, duckdns...). Sem dedup: erro repetido é informação.
  registrarErro(origem, mensagem) {
    this.registrar('erros.log', `${this.horarioLocal()} - ${origem} - ${mensagem}`);
    console.error(pintar('vermelho', `[${origem}] ${mensagem}`, process.stderr));
  }

  // Aviso: condição estranha que não é erro (job pulado, legenda de imagem
  // descartada...). Só console (amarelo) — não precisa de arquivo.
  aviso(origem, mensagem) {
    console.warn(pintar('amarelo', `[${origem}] ${mensagem}`, process.stderr));
  }

  // Informativo operacional (progresso de reencode, aponte de DNS, capa
  // gerada...). Só console, SEM cor — de propósito: deixar o neutro em
  // branco faz as categorias coloridas (conexão/chamada/erro) saltarem. É o
  // funil único, pra não sobrar console.log solto pelos módulos.
  info(origem, mensagem) {
    console.log(`[${origem}] ${mensagem}`);
  }

  // Tentativa barrada (403 da whitelist ou 401 de sessão): auditoria de quem
  // tentou entrar, agora também em disco (logs/bloqueios.log). SEM dedup de
  // propósito: cada tentativa é uma linha — o polling de 20s de um cliente
  // barrado alimenta o log, e esse é exatamente o objetivo (ver auth.js).
  registrarBloqueio(ip, motivo) {
    this.registrar('bloqueios.log', `${this.horarioLocal()} - ${ip} - ${motivo}`);
    console.warn(pintar('amarelo', `[bloqueado] ${ip} - ${motivo}`, process.stderr));
  }
}

const logManager = new LogManager({
  logsDir: LOGS_DIR,
});

module.exports = { LogManager, logManager, pintar };
