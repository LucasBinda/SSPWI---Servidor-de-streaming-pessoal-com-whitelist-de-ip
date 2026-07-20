// Fase 3 — sessão (token+cookie) no front-end.
//
// Duas responsabilidades:
// 1. Renovação em background: o cookie de sessão expira em 30min; a cada
//    ~10min (valor ditado pelo servidor em renovarEmSegundos) pedimos um
//    novo em /auth/session — enquanto a aba estiver aberta, a sessão nunca
//    expira debaixo do usuário.
// 2. Polling de reautorização: se o servidor barrar (403 da whitelist de IP
//    ou 401 de sessão inválida), entramos num loop de 20 em 20 segundos
//    tentando /auth/session de novo. Cada tentativa barrada vira uma linha
//    [ACESSO BLOQUEADO]/[SESSÃO NEGADA] no log do servidor — popular esse
//    log é parte do objetivo (auditoria de quem tentou entrar). Quando o
//    acesso volta (IP re-adicionado à whitelist), o callback dispara e a
//    página recarrega sozinha.
//
// O cookie é HttpOnly — este código nunca vê o token em si, só dispara as
// requisições; o navegador anexa/recebe o cookie sozinho.
const Auth = (() => {
  const INTERVALO_POLLING_MS = 20 * 1000;

  let timerRenovacao = null;
  let timerPolling = null;

  async function pedirSessao() {
    const res = await fetch('/auth/session', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function agendarRenovacao(segundos) {
    clearTimeout(timerRenovacao);
    timerRenovacao = setTimeout(async () => {
      try {
        const dados = await pedirSessao();
        agendarRenovacao(dados.renovarEmSegundos);
      } catch {
        // Renovação em background falhou (IP saiu da whitelist? servidor
        // caiu?) — passa pro modo polling; quando reautorizar, recarrega
        // pra página voltar num estado limpo.
        iniciarPolling(() => window.location.reload());
      }
    }, segundos * 1000);
  }

  // Garante uma sessão válida. true = pode seguir; false = barrado (quem
  // chamou decide a mensagem e normalmente liga o iniciarPolling).
  async function garantir() {
    try {
      const dados = await pedirSessao();
      agendarRenovacao(dados.renovarEmSegundos);
      return true;
    } catch {
      return false;
    }
  }

  function iniciarPolling(aoReautorizar) {
    if (timerPolling) return;
    timerPolling = setInterval(async () => {
      try {
        const dados = await pedirSessao();
        clearInterval(timerPolling);
        timerPolling = null;
        agendarRenovacao(dados.renovarEmSegundos);
        aoReautorizar();
      } catch {
        /* ainda barrado — continua pingando a cada 20s */
      }
    }, INTERVALO_POLLING_MS);
  }

  return { garantir, iniciarPolling };
})();

// Exposto no window de propósito: o player.js virou um <script type="module">
// (escopo próprio), e módulo não enxerga o `const Auth` de um script clássico
// — window.Auth é o ponto de acesso comum pro módulo e pro catalog.js.
window.Auth = Auth;
