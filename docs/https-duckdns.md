# HTTPS com Caddy + DuckDNS (nginx como alternativa)

Como criptografar o tráfego do streaming-server pra acesso pela internet,
usando só peças gratuitas: um subdomínio do **DuckDNS** (o Let's Encrypt
exige domínio — não emite certificado pra IP puro), e um proxy reverso
terminando o TLS na frente do Node.

O caminho recomendado é o **Caddy**: HTTPS automático de fábrica — ele
mesmo emite o certificado Let's Encrypt, renova antes de vencer e
redireciona 80→443. A config inteira são ~4 linhas e não existe certbot no
fluxo. (Prefere nginx + Certbot? Links da documentação oficial no fim.)

A parte de DNS dinâmico é NATIVA do servidor: `lib/duckdns.js` re-aponta o
domínio pro IP da casa a cada 5 minutos, de dentro do próprio processo —
sem cron, sem cliente externo, zero dependência. Você só preenche duas
chaves no `config/settings.json`.

## Arquitetura

```
navegador ──HTTPS──▶ Caddy :443 ──HTTP local──▶ Node :3000
                       │                          │
                       │ TLS terminado aqui;      ├─ whitelist + sessão (como sempre)
                       │ certificado emitido e    └─ lib/duckdns.js re-aponta
                       │ renovado pelo PRÓPRIO       SEUNOME.duckdns.org a cada 5min
                       │ Caddy (Let's Encrypt)
                       └── redirect 80 -> 443 automático
```

Termo técnico: reverse proxy com terminação TLS — o Node é o *upstream*
(*origin server*) e segue servindo HTTP puro em `127.0.0.1:3000`. A
criptografia é 100% offload pro proxy; nenhuma mudança no caminho das
requisições do Node.

## Pré-requisitos

- Um subdomínio DuckDNS (grátis, passo 1).
- **Portas 80 e 443 encaminhadas** no roteador pra máquina do proxy
  (port forwarding) — a 80 é usada na validação do Let's Encrypt e no
  redirect; a 443 é o HTTPS em si.
- Caddy instalado (`sudo pacman -S caddy` no Arch.
  `sudo apt install caddy` no Debian/Ubuntu) Ou outro dependendo do seu SO.
  
## Passo 1 — Conta e domínio no DuckDNS

1. Entre em https://www.duckdns.org e faça login (GitHub/Google).
2. Registre um subdomínio, ex.: `seucinema` → `seucinema.duckdns.org`.
3. Copie o **token** exibido no topo da página. Ele é SEGREDO: com ele,
   qualquer pessoa redireciona seu domínio pra onde quiser.

## Passo 2 — Configurar o servidor (o DNS dinâmico nativo)

Em `config/settings.json`:

```json
"duckdnsDominio": "seucinema",
"duckdnsToken": "seu-token-aqui",
```

Pronto — o servidor passa a re-apontar o domínio a cada 5 minutos (aplica no
próximo ciclo, sem reiniciar; no boot aparece
`[duckdns] DNS dinâmico ativo para seucinema.duckdns.org`). O aponte cobre
IPv4 (o A recebe o IP público do roteador, autodetectado) e IPv6 (o AAAA
recebe o endereço global da máquina, quando houver). Falhas aparecem no log
uma única vez até mudarem de estado — IP estável não gera linha nenhuma.

O `settings.json` real fica FORA do git (`.gitignore`) por causa do token —
só o `settings.example.json` é versionado. Se o seu já estava rastreado de
antes, rode uma vez: `git rm --cached config/settings.json`.

## Passo 3 — Roteador

Encaminhe (NAT/port forwarding) as portas **80** e **443** do roteador pro
IP LAN da máquina do Caddy. Se o provedor bloquear a 80, a validação
HTTP do Let's Encrypt não funciona (o Caddy ainda tenta o desafio
TLS-ALPN, que só precisa da 443).

## Passo 4 — Caddy

A instalação varia por sistema — o guia oficial cobre todos os métodos
(gerenciador de pacotes de cada distro, binário direto, Docker):
**https://caddyserver.com/docs/install**. Num Arch e derivados, por
exemplo:

```sh
sudo pacman -S caddy                                # Arch
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile                      # troque SEUNOME
sudo systemctl enable --now caddy
```

É isso. O Caddy pede o certificado sozinho na subida (acompanhe com
`journalctl -u caddy -f` — a linha "certificate obtained" confirma) e
renova pra sempre sem intervenção. Se o DNS ainda não propagou ou a porta
ainda não estava aberta, ele fica re-tentando sozinho — a ordem dos passos
não é fatal. Editou o Caddyfile com o serviço já rodando? Aplique com
`sudo systemctl reload caddy` (recarrega sem derrubar conexões).

Como o HTTPS automático funciona por dentro (e o que fazer quando algo
foge do padrão): **https://caddyserver.com/docs/automatic-https**. A
referência do Caddyfile e do `reverse_proxy`:
**https://caddyserver.com/docs/caddyfile**.

## Passo 5 — Cookie Secure

Com o HTTPS no ar, ligue em `config/settings.json`:

```json
"atrasDeProxyTls": true
```

O cookie de sessão ganha a flag `Secure` (o navegador só o envia
criptografado). Aplica na próxima renovação de sessão, sem reiniciar.
**Atenção**: ligar isso SEM HTTPS quebra o login — o cookie nunca chega.

## Passo 6 — Conferir

- `https://seucinema.duckdns.org` abre o catálogo com cadeado.
- Play + seek funcionam (o pulo pra qualquer ponto do filme prova que os
  range requests atravessaram o proxy).
- `curl -I http://seucinema.duckdns.org` responde redirect pro https.
- No log do Node, os IPs dos clientes aparecem corretos (não `127.0.0.1`) —
  prova de que o X-Forwarded-For está sendo aceito (o Caddy o envia por
  padrão, e `127.0.0.1` já está em `proxiesConfiaveis`).
- A whitelist continua mandando: IP desconhecido sem cookie → 403, como
  sempre (o TLS criptografa o transporte, não substitui o controle de
  acesso).

## Manutenção

Nenhuma: DuckDNS re-apontado pelo próprio servidor, certificado renovado
pelo próprio Caddy. Se trocar de máquina/roteador, só refazer o port
forwarding.

---

## Alternativa: nginx + Certbot

Se preferir o nginx (mais onipresente, mais botões de ajuste), a config de
proxy pronta pro streaming-server está em `deploy/nginx.conf.example` — a
diferença é que o certificado e a renovação ficam por conta do **Certbot**,
uma ferramenta à parte. Siga a documentação oficial de cada um:

- nginx como reverse proxy:
  https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/
- Certbot (instruções por sistema operacional e servidor web):
  https://certbot.eff.org/instructions

Os passos 1-3, 5 e 6 deste guia valem igual nesse caminho.
