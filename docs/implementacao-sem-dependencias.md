# Implementação sem dependências de terceiros (Node.js puro)

Este documento explica o que mudou no `streaming-server` quando removemos o
`express` e reescrevemos tudo usando só módulos nativos do Node.js
(`http`, `fs`, `path`, `url`). É a continuação prática do documento
`nodejs-npm-terceiros.md`, que explicava o porquê dessa escolha — aqui é o
"como".

## 1. Resultado, em números

| | Antes (com express) | Depois (Node.js puro) |
|---|---|---|
| Dependências diretas | 1 (`express`) | 0 |
| Pacotes em `node_modules/` | 68 | 0 (a pasta nem existe) |
| Precisa rodar `npm install`? | Sim | Não |
| Suporta range requests (seek no vídeo)? | Sim | Sim |
| Suporta subpastas de filmes? | Sim | Sim |
| Suporta whitelist com CIDR (IPv4/IPv6)? | Sim | Sim |

A funcionalidade é a mesma. O que mudou foi só a forma como o servidor
processa a requisição por dentro — antes, o `express` fazia esse trabalho;
agora, o código faz na mão.

## 2. Como o roteamento manual funciona

Sem o `express`, o `server.js` usa `http.createServer`, que recebe uma
função chamada uma vez para cada requisição que chega:

```js
const server = http.createServer((req, res) => {
  // ... aqui dentro decidimos o que fazer com cada requisição
});
```

O `express` guardava, internamente, uma tabela de rotas (`app.get('/api/movies', ...)`)
e escolhia automaticamente qual função chamar. Sem ele, isso vira uma série
de comparações explícitas, na ordem em que aparecem no código:

```js
const parsedUrl = url.parse(req.url, true);
const pathname = decodeURIComponent(parsedUrl.pathname);

if (pathname === '/api/movies') {
  return handleMoviesApi(req, res);
}

if (pathname === '/stream') {
  return handleStream(req, res, parsedUrl.query);
}

if (pathname.startsWith('/covers/')) {
  // ...
}

// se nada bateu, tenta servir como arquivo estático (html, css, js)
```

`url.parse(req.url, true)` faz o trabalho que o `express` fazia por baixo
dos panos: separa o caminho (`pathname`) da query string, e o `true` no
final já devolve a query como um objeto (`{ arquivo: 'filme.mp4' }`), sem
precisar fazer esse parsing manualmente.

## 3. Como a whitelist de IP mudou

No `express`, um middleware recebe `(req, res, next)` e chama `next()`
para deixar a requisição seguir adiante. Sem o `express`, não existe esse
mecanismo de "próximo passo" pronto — então `checarWhitelist` virou uma
função que **retorna `true` ou `false`**, e quem chama decide o que fazer:

```js
// dentro do handler do http.createServer
if (!checarWhitelist(req, res)) {
  return; // a função já escreveu a resposta 403 sozinha
}
```

A lógica de decisão (comparar o IP contra a whitelist, aceitar CIDR, etc.)
não mudou nada — só a forma de "avisar" o código chamador que a requisição
deve parar.

## 4. Como os arquivos estáticos (frontend) passaram a ser servidos

Essa era a parte que o `express.static(...)` resolvia com uma linha. Sem
ele, criamos `lib/staticServer.js`, com uma função `serveStatic(rootDir, relPath, res)`
que faz, na mão, o que o `express.static` fazia por dentro:

1. Decodifica o caminho da URL (`%20` vira espaço, etc.)
2. Monta o caminho completo do arquivo, dentro da pasta permitida
   (`public/` ou `media/covers/`)
3. **Confere que o caminho final continua dentro da pasta permitida** —
   a mesma proteção contra `../../etc/passwd` que já existia no endpoint de
   streaming, aplicada aqui também
4. Descobre o `Content-Type` certo pela extensão do arquivo (`.html`,
   `.css`, `.js`, `.png`, etc.)
5. Envia o arquivo com `fs.createReadStream(...).pipe(res)`

## 5. O que ficou exatamente igual

Estas partes não dependiam do `express` para começar, então não precisaram
mudar:

- `middleware/ipMatch.js` (comparação de IP exato ou CIDR)
- O escaneamento automático de `media/movies/` (incluindo subpastas)
- O sistema de overrides opcional via `data/catalog.json`
- A lógica de range requests (`Range`, `206 Partial Content`) no streaming
- A proteção contra path traversal no streaming

## 6. Testes feitos para validar a reescrita

Antes de considerar pronta, testei (rodando o servidor de verdade, sem
`npm install` nenhum):

1. IP fora da whitelist → `403`
2. IP autorizado acessando `/` → `200`, serve `index.html` corretamente
3. CSS e JS estáticos → `200`, com `Content-Type` correto
4. Catálogo automático, incluindo um arquivo dentro de subpasta e um `.mkv`
   → lista os dois corretamente
5. Streaming de um arquivo dentro de subpasta, com `Range` → `206`
6. Streaming de `.mkv` → `Content-Type: video/x-matroska` correto
7. Tentativa de path traversal no streaming (`?arquivo=../../etc/passwd`)
   → `400`
8. Tentativa de path traversal em arquivo estático, **enviando a
   requisição HTTP crua por socket** (sem deixar o `curl` normalizar o
   `../` antes de enviar, o que mascararia o teste) → confirmei que é o
   próprio código, e não um acaso do cliente HTTP, que bloqueia com `400`

## 7. Trade-offs dessa escolha (sendo honesto sobre o que você ganhou e perdeu)

**Ganhou:**
- Zero pacotes de terceiros — nada que outro mantenedor possa alterar em
  uma atualização futura
- Superfície de auditoria pequena: só os arquivos deste repositório
- Nenhuma dependência de `npm install` funcionando ou do registro do npm
  estar no ar para colocar o projeto para rodar

**Passou a ser sua responsabilidade (que antes o express cobria):**
- Qualquer caso de borda de parsing de `Range` que o express já tratasse e
  não tenha sido coberto aqui
- Suporte a métodos HTTP além de `GET`/`HEAD` (o `server.js` atual
  responde `405` para qualquer outro método — está correto para o caso de
  uso de streaming, mas é uma decisão explícita, não uma cobertura ampla
  de HTTP como o express oferece)
- Qualquer correção de segurança que apareça no futuro para esse tipo de
  servidor HTTP básico precisa ser identificada e corrigida por você
  (ou por mim, na próxima vez que você pedir), já que não existe mais um
  mantenedor de terceiros cuidando dessa camada

## 8. Recomendação

Para o tamanho e o propósito deste projeto (servir um catálogo simples e
fazer streaming para IPs conhecidos), essa troca vale a pena: a
funcionalidade coberta é pequena o suficiente para não precisar de um
framework, e o ganho em previsibilidade (zero dependências de terceiros)
é real e mensurável (68 pacotes a menos). Se o projeto crescer bastante
(autenticação de usuários, múltiplas APIs, etc.), pode valer reavaliar —
mas para o escopo atual, Node.js puro é suficiente e mais alinhado com o
que você pediu.
