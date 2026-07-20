# Padronização e Otimização de Armazenamento

Worker de background que garante que todo vídeo do acervo esteja em `.mp4`
(o único container que o streaming direto via `/stream` + range requests
atende de forma confiável em qualquer navegador, desde a reversão do HLS
on-the-fly, que pesava demais na CPU).

## Fluxo

```
media/movies/ ganha um arquivo não-.mp4
        │
        ├── no boot do servidor ──────────────┐
        └── em cada GET /api/movies ──────────┤  (os dois caminhos chamam
                                              ▼   enfileirarNaoMp4)
                              lib/reencodeWorker.js
                                              │  fila serial, 1 ffmpeg
                                              ▼  por vez, nice -n 19
                     ffprobe: codecs de vídeo/áudio/legenda
                                              │
              ┌───────────────────────────────┴──────────────────────┐
              ▼                                                      ▼
   vídeo já HEVC/AV1?                                     vídeo h264/mpeg4/etc?
   -c:v copy (remux,                                      re-encode: prova de
   segundos, sem perda)                                   velocidade (30s) decide
              │                                           CPU (x265) ou GPU (nvenc)
              └───────────────────────────────┬──────────────────────┘
                                              ▼
                      áudio: aac -> copy; ac3/dts/... -> aac 256k
                      legendas de texto -> mov_text (imagem: descartadas)
                      áudio português -> faixa padrão do container
                      -movflags +faststart (streaming/seek instantâneo)
                                              ▼
                        cache/reencode/job-<ts>.mp4 (temporário)
                                              ▼
                 verificação: ffprobe na saída + duração ±2%
                                              ▼
                 substituição atômica: rename -> media/movies/
                 apaga o original SÓ depois disso
                                              ▼
                 data/catalog.json: entrada aponta pro novo .mp4
                 (título/descrição/capa preservados)
```

## Decisões e porquês

| Decisão | Porquê |
|---------|--------|
| Fila serial (1 job por vez) | Encode é a operação mais pesada do servidor; paralelismo só criaria disputa de CPU |
| `nice -n 19` | Quem está assistindo nunca perde CPU pro worker — ele usa a sobra |
| Copy quando a fonte já é HEVC/AV1 | Remux é ~grátis e sem perda; re-encodar HEVC de novo só degradaria qualidade |
| Prova de velocidade antes do re-encode | Cada modo (CPU e, com GPU NVIDIA, NVENC/NVDEC) converte a origem por até 30s (ou 50% do filme); o mais rápido faz a conversão completa. Modo que falha sai da disputa — é também a detecção automática de hardware, sem chave de configuração |
| Original apagado só após verificação | Falha em qualquer passo preserva o arquivo original intocado |
| Sem retry automático de falhas | Evita loop queimando CPU numa conversão que sempre falha; apague a entrada em `data/reencode-state.json` pra tentar de novo |
| `-tag:v hvc1` | Sem essa tag, Safari/dispositivos Apple não reconhecem HEVC dentro de mp4 |
| `-movflags +faststart` | moov no início do arquivo = play/seek imediato via range requests |
| Faixa `por` como default | Sem transcodificação em tempo real, o navegador toca a faixa padrão do container — então a dublagem precisa ser a padrão |

## Configuração (config/settings.json)

| Chave | Padrão | Efeito |
|-------|--------|--------|
| `reencodeAtivo` | `true` | Liga/desliga o worker (lido a cada enfileiramento, sem restart) |
| `reencodeCodec` | `"libx265"` | Codec do modo CPU da prova de velocidade (`libsvtav1` também disponível) |
| `reencodePreset` | `"fast"` | Velocidade vs. eficiência de compressão |
| `reencodeCrf` | `26` | Qualidade (menor = melhor qualidade e arquivo maior) |

### Prova de velocidade e encoder de hardware (NVENC)

Quando o vídeo precisa de re-encode de verdade, o worker não assume qual
caminho é o mais rápido: disputam uma prova o codec configurado rodando no
CPU e, quando há GPU NVIDIA com driver funcionando, `hevc_nvenc` (encode na
GPU) e `hevc_nvenc` + NVDEC (decode também na GPU). Cada candidato converte
a mesma origem por até 30 segundos — ou até 50% do filme, o que vier
primeiro — com a saída descartada (`-f null`); vence quem sustentou a maior
velocidade média, e só o vencedor converte o arquivo inteiro.

Os candidatos de GPU rodam PRIMEIRO. Numa máquina sem NVIDIA eles falham em
menos de 1 segundo cada e o worker vai direto pro software, **sem gastar os
30s da prova dele** — não há o que comparar quando o software é a única
opção. Só quando alguma GPU responde é que o software também é provado, pra
escolher de verdade o mais rápido. Ou seja: a prova é também a detecção
automática de hardware, sem nenhuma chave de configuração, e em máquinas
sem GPU o custo dela é praticamente zero.

No NVENC, o `reencodeCrf` é aplicado como `-cq` (mesma escala) e presets do
x26x são traduzidos para `p1`-`p7`. A compressão do NVENC é pior que a do
libx265 — arquivos ~1,3-1,8x maiores na mesma qualidade percebida — mas a
conversão é ~10x mais rápida e quase não usa CPU; suba o `reencodeCrf` se o
tamanho pesar mais que a qualidade.

## Estado

`data/reencode-state.json` (gitignorado) guarda o status por arquivo:
`pending` → `processing` → `done` | `failed` (com detalhe e timestamp).
Jobs `processing` interrompidos por crash/restart voltam pra `pending` no
boot seguinte; temporários órfãos em `cache/reencode/` são limpos.

## Compatibilidade de reprodução (nota honesta)

HEVC em navegador: Safari toca sempre; Chrome/Edge dependem de decodificação
por hardware (GPUs de ~2016 em diante); Firefox tem suporte limitado. Se
algum cliente da casa não tocar HEVC, troque `reencodeCodec` pra `libx264`
(compatibilidade universal, arquivos maiores) — fontes já em HEVC continuam
sendo copiadas sem re-encode de qualquer forma.
