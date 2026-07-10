# Testes de segurança — reprodução manual

Este arquivo acompanha, na ordem de gravidade da auditoria, cada bug
encontrado: como reproduzir (pra você confirmar que existe de verdade) e,
depois, como confirmar que a correção realmente fechou o problema. Rode os
comandos você mesmo — não confie só na minha palavra.

Convenção usada em todos os testes: rode a partir da pasta raiz do projeto,
com o servidor parado no início de cada teste.

---

## 1. [CRÍTICO] Bypass da whitelist de IP via `X-Forwarded-For` forjado

**O bug:** `middleware/ipWhitelist.js` confia em qualquer valor do cabeçalho
`X-Forwarded-For` que o cliente mandar, mesmo quando não existe nenhum proxy
reverso de verdade na frente do servidor. Como esse cabeçalho é definido
pelo próprio cliente HTTP, qualquer um pode se passar por um IP da
whitelist.

### Como reproduzir

```bash
# 1. Guarde sua whitelist real e coloque uma temporária, propositalmente
#    SEM o seu IP local (127.0.0.1) — só um IP qualquer que não é o seu,
#    pra simular "estou de fora da whitelist":
cp config/whitelist.json config/whitelist.json.bak
cat > config/whitelist.json << 'EOF'
{ "allowedIps": ["10.0.0.99"] }
EOF

# 2. Suba o servidor
node server.js &
sleep 1

# 3. Requisição normal — sem forjar nada. Deve dar 403, porque 127.0.0.1
#    não está na whitelist temporária.
curl -i http://127.0.0.1:3000/api/movies | head -1

# 4. A MESMA conexão real (ainda é você, em 127.0.0.1), mas agora forjando
#    o cabeçalho pra alegar que é o IP que ESTÁ na whitelist:
curl -i -H "X-Forwarded-For: 10.0.0.99" http://127.0.0.1:3000/api/movies | head -1

# 5. Restaure sua whitelist real e derrube o servidor de teste
kill %1
mv config/whitelist.json.bak config/whitelist.json
```

### Resultado esperado (se o bug existir)

| Passo | Requisição | Resultado esperado com o bug |
|---|---|---|
| 3 | sem forjar nada | `403` (bloqueado corretamente) |
| 4 | com `X-Forwarded-For: 10.0.0.99` forjado | `200` (⚠️ acesso liberado sem autorização real) |

### Resultado obtido rodando agora, contra o código atual

```
--- passo 3 (sem forjar) ---
HTTP/1.1 403 Forbidden
--- passo 4 (forjando X-Forwarded-For) ---
HTTP/1.1 200 OK
```

**Confirmado: o bug existe.** `STATUS: A CORRIGIR`

### A correção aplicada

- Novo campo `config/settings.json -> proxiesConfiaveis` (padrão:
  `["127.0.0.1", "::1"]`): só confiamos em `X-Forwarded-For` quando o peer
  DIRETO da conexão TCP (não forjável) já é, ele mesmo, um proxy conhecido.
- Quando confiamos no cabeçalho, usamos o **último** valor da lista (o que
  o proxy confiável realmente observou), nunca o primeiro (o que a
  requisição original alegou).

### Testes pós-correção

**Teste A — repetindo o ataque original:** com `127.0.0.1` na lista padrão
de `proxiesConfiaveis`, o teste original (passo 4) continua dando `200`.
Isso **não é um resíduo do bug** — é o comportamento correto quando você
roda um proxy confiável (nginx) na própria máquina: o servidor passa a
tratar essa conexão como legítima e olha o cabeçalho. É por isso que os
testes B e C abaixo são os que realmente provam a correção.

**Teste B — cenário "sem proxy nenhum" (`proxiesConfiaveis: []`),** igual
ao deploy documentado no README sem nginx:
```bash
# edite config/settings.json temporariamente:
# { "removerFilmesAusentesDoCatalogo": true, "proxiesConfiaveis": [] }
curl -i -H "X-Forwarded-For: 10.0.0.99" http://127.0.0.1:3000/api/movies | head -1
```
Resultado obtido: `HTTP/1.1 403 Forbidden` ✅ (cabeçalho ignorado, como deveria)

**Teste C — cenário "com nginx local" (padrão), simulando o cabeçalho de
duas pontas que o nginx real geraria** (`$proxy_add_x_forwarded_for`
acrescenta o IP real no final):
```bash
# whitelist temporária: { "allowedIps": ["10.0.0.99"] }  (não inclui o IP "real" 8.8.8.8)
curl -i -H "X-Forwarded-For: 10.0.0.99, 8.8.8.8" http://127.0.0.1:3000/api/movies | head -1
```
Resultado obtido: `HTTP/1.1 403 Forbidden` ✅ (usou o ÚLTIMO valor —
8.8.8.8, não autorizado — em vez do primeiro, forjado)

**Teste de controle positivo** — mesmo cenário C, mas agora com
`{ "allowedIps": ["8.8.8.8"] }` (o IP real desta vez está na whitelist):
Resultado obtido: `HTTP/1.1 200 OK` ✅ (confirma que o caso legítimo
continua funcionando — não é um bloqueio geral indiscriminado)

**`STATUS: CORRIGIDO E VERIFICADO`**
