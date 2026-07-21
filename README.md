# Servidor de streaming pessoal (whitelist de IP)

Servidor Node.js minimalista (sem Express, sem nenhum pacote de terceiros):
mostra um catálogo de filmes e faz o streaming do vídeo escolhido via HTTP,
liberado apenas para IPs autorizados. Não há banco de dados nem cadastro —
o catálogo é um JSON e a autorização é por IP + cookie de sessão assinado.

Além do catálogo e do streaming, o servidor cuida sozinho de três coisas em
segundo plano:

- **Padronização do acervo**: vídeo adicionado em formato diferente de
  `.mp4` (MKV, AVI...) é convertido automaticamente pra `.mp4` por um
  worker de baixa prioridade, substituindo o original (veja
  `docs/fase2-worker-reencode.md`).
- **Capas automáticas**: filme sem capa ganha uma — um frame aleatório do
  próprio vídeo, extraído entre 20% e 80% da duração.
- **Login persistente**: além da whitelist de IP, as rotas de conteúdo
  exigem um cookie de sessão assinado (HMAC) que identifica o usuário e
  sobrevive a troca de IP (renovação de 2 dias, teto de 7); o front-end
  renova em background e, se for barrado, tenta reautorizar a cada 20
  segundos (populando o log de segurança a cada tentativa).

No player, o botão de engrenagem abre o painel de configurações: seletor de
legenda (extraída na hora de dentro do arquivo, se houver), lista das
faixas de áudio e um equalizador de 6 bandas com nivelamento automático de
volume (Web Audio API, tudo no navegador).

## Requisitos obrigatórios

Sem qualquer um destes o servidor não funciona:

1. **Node.js 18 ou superior** — todo o servidor roda só com módulos nativos
   (`http`, `fs`, `path`, `crypto`, `child_process`); não existe
   `node_modules/` nem `npm install` pra rodar.
2. **`ffmpeg` e `ffprobe` no PATH** — usados pela conversão automática pra
   `.mp4`, pela extração de legendas embutidas e pela geração das capas.
   No Arch/CachyOS: `pacman -S ffmpeg`; no Debian/Ubuntu:
   `apt install ffmpeg`. Confira com `ffmpeg -version`.
3. **`config/whitelist.json` criado e com os seus IPs** — sem esse arquivo
   toda requisição responde erro 500; com ele vazio, ninguém entra. Veja o
   passo 1 de "Como rodar" abaixo.

## Como rodar

```bash
# 1. crie a whitelist a partir do exemplo e edite com os IPs autorizados
#    (inclua 127.0.0.1 para testar da própria máquina)
cp config/whitelist.example.json config/whitelist.json

# 2. coloque seus vídeos em media/movies/ (qualquer formato — ver abaixo)
mv /caminho/dos/seus/filmes/* media/movies/

# 3. suba o servidor (porta 3000 por padrão; ajuste com PORT=8080 etc.)
npm start
```

Acesse `http://<ip-do-servidor>:3000` de qualquer máquina cujo IP esteja na
whitelist. O catálogo, as capas, a conversão de formato e o cookie de login
acontecem sozinhos a partir daí.

Para acessar o servidor pelo ipv6: `http://[<ip-do-servidor>]:3000` use os colchetes em volta do ip.

## Adicionando filmes

Basta copiar os arquivos pra `media/movies/` (subpastas valem e viram
organização livre sua) — **o formato não importa**: o worker de
padronização converte qualquer coisa pra `.mp4` sozinho, então pode jogar
MKV, AVI, WEBM, MOV ou OGG direto na pasta. O catálogo é montado
automaticamente (o servidor escaneia a pasta no boot e a cada carga da
página, gerando título a partir do nome do arquivo):

```
media/movies/
├── filme-solto.mp4
├── acao/
│   └── filme-de-acao.mkv      <- será convertido pra .mp4 sozinho
└── comedia/
    └── outro-filme.avi        <- idem
```

Como funciona a padronização: qualquer arquivo que não seja `.mp4` entra na
fila do **worker de conversão**, que roda em background com prioridade
mínima de CPU (`nice -19`, sem disputar com quem está assistindo) e
substitui o original **só depois** de verificar que a conversão deu certo.
Fontes já em HEVC/AV1 são só remuxadas (segundos, sem perda de qualidade);
codecs antigos são re-encodados pra H.265, poupando espaço em disco. O
progresso fica em `data/reencode-state.json` e no log do servidor; detalhes
e configuração em `docs/fase2-worker-reencode.md`.

Enquanto a conversão não termina, o arquivo original ainda aparece no
catálogo — se o navegador do PC remoto não tocar aquele formato, o player
mostra um aviso e basta esperar a conversão concluir.

### Customizando título, descrição ou capa (opcional)

Você **não precisa criar `data/catalog.json` manualmente** — ele não existe
até você rodar o servidor com pelo menos um filme na pasta, e a partir daí é
mantido automaticamente (veja a seção seguinte). Ele fica de fora do Git
(está no `.gitignore`, junto com a whitelist), porque reflete a sua coleção
pessoal — títulos, descrições e nomes de arquivo específicos do seu acervo.

Para saber o formato, veja `data/catalog.example.json` (esse sim é
versionado no Git, só como referência). Para customizar um filme
específico depois que ele já foi detectado, edite a entrada correspondente
em `data/catalog.json` pelo caminho relativo do arquivo (`arquivo`):

```json
[
  {
    "arquivo": "acao/filme-de-acao.mkv",
    "titulo": "Título customizado",
    "descricao": "Descrição breve.",
    "capa": "/covers/filme-de-acao.jpg"
  }
]
```

Se quiser, edite esses campos manualmente depois — na próxima vez que o
catálogo for carregado, essa entrada não é mais tocada (só campos vazios
"puxam" o padrão automático em tela; o arquivo em si só recebe entradas
novas, nunca sobrescreve as que você já editou).

Capas (opcional) vão em `media/covers/` e são referenciadas como
`/covers/nome-do-arquivo.jpg`.

### Capas automáticas

Filme sem capa não fica sem capa: no boot do servidor e a cada carga do
catálogo, um **aleatorizador de capas** (`lib/coverPicker.js`) extrai um
frame do próprio vídeo — num ponto aleatório entre 20% e 80% da duração,
longe de abertura e créditos — e grava em `media/covers/auto/`, atualizando
o campo `capa` da entrada em `data/catalog.json`.

Regras que ele segue:

- **Nunca sobrescreve** uma capa que você definiu e que existe em disco —
  só ocupa o campo quando está vazio.
- **Capa referenciada que sumiu do disco é regerada** pelo mesmo processo
  (vale pra qualquer capa local `/covers/...`; URLs externas ficam por sua
  conta).
- **Filme removido de `media/movies/` leva a capa automática junto** — nada
  de jpg órfão acumulando.
- Não gostou do frame sorteado? Apague o jpg em `media/covers/auto/` (um
  novo ponto aleatório é sorteado) ou aponte o campo `capa` pra uma imagem
  sua.
- Quer capas "vivas"? Com `"trocarCapasAutoNoCatalogo": true` em
  `config/settings.json`, cada carga do catálogo sorteia um frame novo pra
  todas as capas automáticas (as definidas à mão continuam intocadas).
  Padrão: `false` — a capa sorteada na primeira vez fica fixa.

### Remoção automática de filmes apagados

Além de adicionar filmes novos, o servidor também **remove** do
`data/catalog.json` qualquer entrada cujo arquivo não existe mais em
`media/movies/` (por exemplo, se você apagou ou moveu o arquivo). Essa
opção vem **ativada por padrão**, mas pode ser desligada em
`config/settings.json`:

```json
{ "removerFilmesAusentesDoCatalogo": false }
```

Com `false`, entradas de filmes ausentes ficam guardadas no arquivo mesmo
que o vídeo não esteja mais na pasta (útil se você move arquivos grandes
para um HD externo temporariamente e não quer perder a descrição/capa que
já preencheu). Assim como a whitelist, esse arquivo é lido a cada
requisição — não precisa reiniciar o servidor depois de editar.

### Proxies confiáveis (importante para a segurança da whitelist)

`config/settings.json` também tem `proxiesConfiaveis` (padrão:
`["127.0.0.1", "::1"]`). Esse campo controla em quais casos o servidor
confia no cabeçalho `X-Forwarded-For` para descobrir o IP real do
cliente — algo necessário quando você usa o nginx do `deploy/` na frente
(ele repassa o IP original nesse cabeçalho), mas que **precisa ser
restrito**, porque `X-Forwarded-For` é definido pelo próprio cliente HTTP
e pode ser forjado por qualquer um.

A regra: só confiamos nesse cabeçalho quando a conexão TCP direta (que não
pode ser forjada) já vem de um IP desta lista. Se você expõe a porta `3000`
diretamente (sem nginx), **deixe a lista vazia** (`"proxiesConfiaveis": []`)
para que o cabeçalho seja completamente ignorado e só o IP real da conexão
importe. Se você usa o nginx do `deploy/` rodando na mesma máquina, o
padrão (`127.0.0.1`) já é o valor certo. Veja
`docs/testes-de-seguranca.md`, item 1, para reproduzir e confirmar esse
comportamento você mesmo.

### Opções do worker de conversão

Também em `config/settings.json` (padrões entre parênteses):
`reencodeAtivo` (`true`) liga/desliga o worker; `reencodeCodec`
(`"libx265"`), `reencodePreset` (`"fast"`) e `reencodeCrf` (`26`) controlam
o re-encode quando ele é necessário de verdade — fontes já em HEVC/AV1 são
só remuxadas, sem re-encodar. Se algum aparelho da casa não decodificar
HEVC (Chrome/Edge dependem de suporte por hardware; Firefox é limitado),
troque `reencodeCodec` pra `"libx264"`. Tabela completa em
`docs/fase2-worker-reencode.md`.

## Configurando a whitelist de IP

Copie o exemplo e edite com os IPs que podem acessar o servidor:

```bash
cp config/whitelist.example.json config/whitelist.json
```

```json
{ "allowedIps": ["192.168.0.10", "203.0.113.55"] }
```

`config/whitelist.json` está no `.gitignore` de propósito, para não vazar
seus IPs autorizados caso você suba este projeto pro GitHub — só o
`.example.json` é versionado.

### IPv6

O servidor já escuta em IPv4 e IPv6 ao mesmo tempo, sem precisar configurar
nada — é o padrão do Node.js. A whitelist aceita tanto um IP exato quanto uma
faixa em notação CIDR (`192.168.0.0/24` ou `2804:14d::/48`). Faixas são úteis
principalmente para IPv6: muitos sistemas operacionais trocam periodicamente
o endereço IPv6 do próprio dispositivo (privacy extensions), então liberar o
endereço exato pode parar de funcionar depois de um tempo. Liberar o prefixo
que sua operadora atribui (geralmente estável) é mais confiável.

### Porta para acesso de outra rede

Por padrão o servidor escuta na porta `3000` (ajustável com a variável de
ambiente `PORT`). Para alguém de fora da sua rede local acessar:

- **Sem o nginx do `deploy/`**: encaminhe a porta `3000` no seu roteador
  (*port forwarding*) para o IP interno da máquina que roda o servidor.
- **Com o nginx do `deploy/`** (recomendado): encaminhe a porta `80` (ou
  `443` com HTTPS) para a máquina do nginx, e mantenha a `3000` acessível só
  via `localhost` — assim quem está de fora nunca fala direto com o Node, só
  com a camada que já filtra por IP antes.

O arquivo é lido a cada requisição — não precisa reiniciar o servidor depois
de editar. Descubra o IP público de quem vai assistir em
https://whatismyipaddress.com (se for um IP dinâmico, veja a seção abaixo).

## Login persistente (token + cookie) integrado à whitelist

A whitelist manual decide **quem consegue fazer login**; a partir daí o
cookie de sessão vira um **login persistente do usuário**, que sobrevive a
troca de IP. Funciona assim, sem nenhuma ação sua:

1. No primeiro acesso (que precisa vir de um IP da lista manual), a página
   pede um token em `/auth/session`. O servidor emite um cookie `HttpOnly`
   assinado com HMAC-SHA256 contendo um id de usuário — é esse id que vai
   ancorar dados por usuário, como o tempo assistido de cada filme.
2. **Renovação deslizante**: enquanto o site está em uso, o front-end
   renova o cookie em background — cada renovação estica a validade em
   **2 dias** (constante `DURACAO_SESSAO_DIAS` em `lib/sessionToken.js`),
   com **teto absoluto de 7 dias** contados do primeiro login
   (`VIDA_MAXIMA_DIAS`): depois disso o login renasce do zero, o que exige
   estar de novo num IP da lista manual.
3. **O IP acompanha o usuário**: se alguém com login válido aparecer num IP
   fora da whitelist (trocou de rede, IPv6 rotativo), o IP novo é
   matriculado automaticamente em `autoAllowedIps` no
   `config/whitelist.json` — com validade colada na da sessão e registro de
   qual usuário o autorizou. Entradas vencidas são podadas sozinhas; a sua
   lista manual (`allowedIps`) nunca é tocada.
4. Se o servidor barrar de vez (sem IP autorizado E sem cookie válido), o
   front-end entra num **loop de reautorização a cada 20 segundos** — cada
   tentativa gera `[ACESSO BLOQUEADO]`/`[SESSÃO NEGADA]` no log, de
   propósito: é o rastro de auditoria. Quando o acesso volta, a página
   recarrega sozinha.

O segredo HMAC é gerado no primeiro boot e fica em `data/session-secret`
(fora do Git). Consequência honesta do modelo: um cookie roubado dá acesso
de qualquer IP **até expirar** — o teto de 7 dias e o `HttpOnly` limitam a
janela; se suspeitar de vazamento, apague `data/session-secret` e reinicie
(todas as sessões caem na hora).

## Tempo assistido (retomar de onde parou)

O player salva a minutagem de cada filme **por usuário** (o id do cookie de
login) e retoma de onde a pessoa parou — com 3s de recuo pra recuperar o
contexto da cena. Os vídeos ficam no file system; a minutagem fica separada
em `data/watchtime.json` (fora do Git), o "banco de dados" do projeto.

- A gravação é leve: um `sendBeacon` a cada 15s enquanto toca, ao pausar e
  ao fechar a aba (o `sendBeacon` sobrevive ao fechamento — justamente o
  momento mais importante de salvar).
- Filme assistido até o fim zera a minutagem — a próxima sessão começa do
  início em vez de "retomar" nos créditos; perto do fim (>95%) também não
  retoma.
- Registros sem atualização há mais de 7 dias (o teto de vida de um login)
  são podados automaticamente — o arquivo não cresce pra sempre.
- Se o worker de conversão renomear um arquivo (`.mkv` → `.mp4`), a
  minutagem de todos os usuários acompanha o nome novo.

## Segurança — recomendações além do essencial

O que está aqui já funciona, mas para expor isso na internet (fora da sua
rede local), vale reforçar:

- **Whitelist em duas camadas**: o middleware já filtra por IP, mas um
  firewall ou reverse proxy na frente (veja `deploy/nginx.conf.example`)
  recusa a conexão antes mesmo de chegar na aplicação — assim, mesmo se
  houver um bug no código, a rede já barra o acesso indevido.
- **IP dinâmico**: se o PC remoto não tem IP fixo, a whitelist vai ficar
  desatualizada. Alternativas: usar um serviço de DDNS para saber o IP atual,
  ou trocar a exposição pública por um túnel WireGuard entre as duas
  máquinas — geralmente mais simples de manter e mais seguro que abrir a
  porta na internet.
- **HTTPS**: como é só streaming de leitura, HTTP já resolve, mas se o
  tráfego passar pela internet aberta, HTTPS evita que o link do vídeo (ou o
  próprio conteúdo) seja visível a qualquer um na mesma rede. O caminho
  suportado é Caddy + DuckDNS (domínio grátis, com o DNS dinâmico
  re-apontado pelo próprio servidor; nginx+Certbot como alternativa) —
  passo a passo completo em `docs/https-duckdns.md`.
- **Formato de vídeo**: o worker de padronização já converte tudo pra
  `.mp4` sozinho — se um filme recém-adicionado não tocar, é só esperar a
  conversão em background terminar (acompanhe pelo log ou por
  `data/reencode-state.json`).

## Estrutura do projeto

```
streaming-server/
├── server.js                 # ponto de entrada — roteamento manual (http nativo)
├── middleware/
│   ├── ipWhitelist.js          # filtro de IP (primeira camada de acesso)
│   ├── sessionCookie.js         # sessão token+cookie (segunda camada, rotas de conteúdo)
│   └── ipMatch.js                # comparação de IP exato ou faixa CIDR
├── routes/
│   ├── movies.js                # catálogo automático + streaming com range requests
│   ├── media.js                  # faixas de áudio/legenda (ffprobe) + legendas WebVTT
│   └── watchTime.js               # minutagem assistida por usuário (get/save leves)
├── lib/
│   ├── staticServer.js          # serve o frontend e as capas
│   ├── settings.js               # leitura centralizada de config/settings.json
│   ├── sessionToken.js            # emissão/verificação do token HMAC de sessão
│   ├── watchTime.js                # persistência da minutagem por usuário (data/watchtime.json)
│   ├── mediaTools.js               # ffprobe com cache + extração de legendas
│   ├── reencodeWorker.js            # worker de conversão pra mp4 (fila serial, nice -19)
│   └── coverPicker.js                # aleatorizador de capas (frame entre 20% e 80%)
├── config/
│   ├── whitelist.json             # IPs autorizados (fora do Git)
│   ├── whitelist.example.json      # exemplo versionado no Git
│   └── settings.json                # opções gerais (proxies, remoção automática, re-encode)
├── data/
│   ├── catalog.example.json       # exemplo do formato (catalog.json real é gerado, fora do Git)
│   ├── reencode-state.json         # estado do worker de conversão (gerado, fora do Git)
│   ├── session-secret               # segredo HMAC das sessões (gerado, fora do Git)
│   └── watchtime.json                # minutagem por usuário (gerado, fora do Git)
├── media/
│   ├── movies/                     # arquivos de vídeo (fora do Git)
│   └── covers/                      # capas — as automáticas ficam em covers/auto/ (fora do Git)
├── cache/                           # legendas extraídas + temporários de conversão (fora do Git)
├── public/                          # frontend (catálogo + player + auth com polling de 20s)
├── deploy/                          # exemplos de nginx e systemd (opcionais)
└── docs/                            # documentação técnica e testes de segurança
```

Este projeto não depende de nenhum pacote de terceiros — só do próprio
Node.js. Veja `docs/implementacao-sem-dependencias.md` para o
detalhamento de como o roteamento manual substitui o que o `express`
fazia, e `docs/testes-de-seguranca.md` para reproduzir cada vulnerabilidade
já corrigida e confirmar você mesmo que a correção funciona.
