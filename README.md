# Servidor de streaming pessoal (whitelist de IP)

Servidor Node.js/Express minimalista: mostra um catálogo de filmes e faz o
streaming do vídeo escolhido via HTTP, liberado apenas para IPs autorizados.
Não há banco de dados nem cadastro — o catálogo é um JSON e a autorização é
por IP.

## Requisitos

- Node.js 18 ou superior

## Instalação

```bash
npm install
```

## Adicionando filmes

O catálogo é montado **automaticamente**: o servidor escaneia `media/movies/`
(incluindo subpastas) a cada vez que a página é carregada, e gera um título a
partir do nome do arquivo. Não é preciso editar nada — basta copiar os
arquivos:

```
media/movies/
├── filme-solto.mp4
├── acao/
│   └── filme-de-acao.mkv
└── comedia/
    └── outro-filme.mp4
```

Formatos aceitos: `.mp4`, `.mkv`, `.webm`, `.mov`, `.avi`, `.ogg`. **Na
prática, `.mp4` com codec H.264 + AAC é o único que toca de forma confiável
em qualquer navegador** — o servidor envia `.mkv` e os outros formatos
corretamente, mas a reprodução depende do navegador do PC remoto (Safari não
tem suporte a MKV; Chrome e Firefox dependem do codec interno do arquivo).
Se um filme não tocar, converta com:

```bash
ffmpeg -i entrada.mkv -c:v libx264 -c:a aac saida.mp4
```

### Customizando título, descrição ou capa (opcional)

Por padrão o título vem do nome do arquivo. Para customizar algum filme
específico, edite `data/catalog.json` — ele funciona como uma sobreposição,
identificada pelo caminho relativo do arquivo (`arquivo`), e é totalmente
opcional (pode até apagar o arquivo, ou deixar `[]`):

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

Capas (opcional) vão em `media/covers/` e são referenciadas como
`/covers/nome-do-arquivo.jpg`.

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

O arquivo é lido a cada requisição — não precisa reiniciar o servidor depois
de editar. Descubra o IP público de quem vai assistir em
https://whatismyipaddress.com (se for um IP dinâmico, veja a seção abaixo).

## Rodando

```bash
npm start
```

Acesse em `http://<ip-do-servidor>:3000` a partir do PC remoto autorizado.

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
  próprio conteúdo) seja visível a qualquer um na mesma rede. O caminho mais
  simples é o Certbot por cima do nginx do exemplo em `deploy/`.
- **Formato de vídeo**: arquivos `.mkv` ou com codecs incomuns podem não
  tocar direto no navegador. Se isso acontecer, converta antes com
  `ffmpeg -i entrada.mkv -c:v libx264 -c:a aac saida.mp4`.

## Estrutura do projeto

```
streaming-server/
├── server.js              # ponto de entrada
├── middleware/
│   └── ipWhitelist.js      # filtro de IP (camada de acesso)
├── routes/
│   └── movies.js           # API do catálogo + streaming com range requests
├── config/
│   └── whitelist.json      # IPs autorizados
├── data/
│   └── catalog.json        # lista de filmes
├── media/
│   ├── movies/              # arquivos de vídeo
│   └── covers/               # capas dos filmes
├── public/                  # frontend (catálogo + player)
└── deploy/                  # exemplos de nginx e systemd (opcionais)
```
