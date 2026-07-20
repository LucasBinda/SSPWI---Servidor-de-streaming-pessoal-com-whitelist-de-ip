const { spawn } = require('child_process');

// Helper único pro boilerplate de rodar ffmpeg/ffprobe: capturar a "cauda"
// do stderr pra mensagem de erro, padronizar o erro de binário ausente
// ("está instalado e no PATH?") e resolver/rejeitar pelo código de saída.
// Antes esse mesmo bloco spawn+stderr+Promise aparecia repetido em
// mediaTools (probe/legenda/áudio) e coverPicker (capa).
//
// O worker de re-encode (lib/reencodeWorker.js) NÃO usa este helper de
// propósito: os spawns dele são especializados (wrapper `nice -n 19`,
// parsing de progresso no stdout, kill por timeout na prova de velocidade,
// rastreio do processo atual pra matar no shutdown) e já vêm testados —
// forçá-los aqui só adicionaria risco ao caminho mais crítico.
//
// opts:
//   bin             'ffmpeg' (padrão) | 'ffprobe'
//   capturarStdout  true -> resolve com { stdout } inteiro (ffprobe JSON)
// Resolve: { stdout } (stdout só preenchido quando capturarStdout).
// Rejeita: Error com a cauda do stderr, ou falha de spawn.
function runFfmpeg(args, opts = {}) {
  const bin = opts.bin || 'ffmpeg';
  return new Promise((resolve, reject) => {
    // stdout só é canalizado quando interessa (ffprobe) — os ffmpeg de
    // extração escrevem no arquivo de saída, não no stdout.
    const stdio = ['ignore', opts.capturarStdout ? 'pipe' : 'ignore', 'pipe'];
    const proc = spawn(bin, args, { stdio });

    let stdout = '';
    let stderrTail = '';
    if (opts.capturarStdout) {
      proc.stdout.on('data', (chunk) => { stdout += chunk; });
    }
    proc.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });
    proc.on('error', (err) => {
      reject(new Error(`falha ao iniciar ${bin} (está instalado e no PATH?): ${err.message}`));
    });
    proc.on('close', (code) => {
      if (code === 0) return resolve({ stdout });
      reject(new Error(`${bin} saiu com código ${code}: ${stderrTail.trim().slice(-500)}`));
    });
  });
}

module.exports = { runFfmpeg };
