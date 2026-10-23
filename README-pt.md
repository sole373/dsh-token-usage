# dsh-token-usage

> Análise de consumo de tokens e ranking de capacidade de modelos para o DeepSeek Harness — um plugin.

[English](README.md) | [中文](README-zh.md) | [Español](README-es.md) | Português | [हिन्दी](README-hi.md)

## What it does

Este plugin analisa **os logs de sessão que o próprio host escreve**, agrupa os
registros por provedor e modelo, e mostra tendências de consumo, taxa de acerto de
cache e a distribuição de uso entre modelos. Depois alinha **os modelos que você
realmente usou** com um ranking público de capacidades.

| Capacidade | Ponto de entrada |
| --- | --- |
| Painel de consumo | "Token usage" na barra lateral → painel principal |
| JSON de consumo | `GET {prefix}/usage` (aceita `days=` e `refresh=1`) |
| Ranking de modelos | Rodapé do painel de consumo |
| JSON do ranking | `GET {prefix}/model-rank` (aceita `refresh=1`) |

**Este plugin nunca toca nas suas contas.** Ele apenas lê os logs de sessão do próprio
host: não inicia fluxo OAuth, não copia credenciais, não registra provedores de
modelos e não altera nenhum cliente.

## How it relates to `dsh-agent-checkin`

**Não tem relação.** Os dois plugins são independentes e podem ser instalados
separadamente. O painel de consumo viveu dentro do `dsh-agent-checkin` até a 0.8.0; a
partir da 0.9.0 é um plugin à parte: não compartilham código, nem arquivos de cache,
nem se chamam entre si.

| | `dsh-agent-checkin` | `dsh-token-usage` |
| --- | --- | --- |
| O que faz | Check-in diário, saldos de créditos, clientes locais como provedores de modelos | Análise de consumo e ranking de capacidade |
| Fonte de dados | O estado de sessão dos clientes locais | Os logs de sessão do próprio host |
| Lê arquivos do outro? | —— | **Não** |

## Requirements

- DeepSeek Harness (`dsh`) 0.1.7 ou superior, com interface web no combo
- Node.js `^22.19.0 || >=24.0.0`
- Um log de sessão local legível (padrão `$DSH_HOME/sessions`, ou `~/.dsh/sessions`)

## Installation

```bash
dsh plugin add @sole373/dsh-token-usage
```

Ou acrescente uma linha ao `cordis.patch.yml` do perfil:

```yaml
- id: dsh-token-usage
  name: '@sole373/dsh-token-usage'
```

## Usage

### The usage panel

O painel mostra, de cima para baixo: números-resumo (consumo total / hoje / últimos 7
dias / número de chamadas, mais acertos de cache, falhas e taxa de acerto), quatro
gráficos (tendência de consumo, distribuição por provedor, modelos mais usados e
capacidade dos modelos que você usou), uma tabela de detalhe por origem, o ranking de
modelos com recomendações por tarefa (programação / raciocínio / agêntico / contexto
longo / visão / melhor custo-benefício; um mesmo modelo disponível em várias plataformas
aparece como uma única linha com todas elas na coluna de origem) e um rodapé com o custo
real da varredura.

A janela de tempo pode ser de 7 / 30 / 90 dias ou "tudo". "Refresh" força uma nova
varredura; o resto usa o cache.

### How the numbers are computed

| Métrica | Definição |
| --- | --- |
| Tokens por registro | `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`, somados em separado |
| Denominador da taxa de acerto | `input + cacheRead + cacheWrite` (**sem output**: o que foi gerado não é o que entrou) |
| Denominador zero | Mostra "—", **não 0%** |
| Corte de dia | Fuso horário local, não UTC |
| "Total" | Todo o histórico; os três números de cache usam a mesma base |

> **Por que não o campo `totalTokens`**: é uma medição antiga e não corresponde
> necessariamente à soma dos quatro segmentos. Todo total da página é somado por
> segmentos.
>
> **Por que apenas `assistant/message`**: `assistant/attempt` guarda uma cópia da mesma
> medição de uso; contar os dois dobraria o total.

### The incremental cache

Os logs de sessão só crescem, então não há razão para reler tudo. O scanner registra
`size + mtime` de cada arquivo e só relê os que mudaram.

- Varredura completa a frio: algumas dezenas de logs / dezenas de MB, ~1,4 s
- Atualizações rotineiras: milissegundos de um dígito com o cache aquecido
- Sem SQLite: sem dependência nativa, sem migração de schema, sem estado pela metade

### The model leaderboard

Duas fontes, rigorosamente separadas: as **notas de capacidade** vêm de um ranking
público (a API `/api/v1/models` do OpenRouter, sem autenticação, com os índices
intelligence / coding / agentic do Artificial Analysis), e o **escopo** são **todos os
modelos chamáveis agora por este host**: o `ctx.llm` oficial (LlmRuntime) enumera os
modelos anunciados de cada plataforma, então cada ativação/desativação em
"Plataformas e Modelos" reflete-se fielmente.

> ⚠️ **Declaração de escopo (impressa no painel, não escondida)**: o ranking só responde
> "qual é a nota deste modelo", **não** "você tem direito de chamá-lo".

`rankScope` aceita outros dois valores: `used` classifica só os modelos que realmente
aparecem nos seus logs de sessão (inclusive chamadas históricas de modelos em desuso), e
`all` classifica o ranking público inteiro. Se a enumeração do catálogo falhar, o painel
informa honestamente "catálogo indisponível" e **nunca** recua em silêncio para outro
escopo.

### Leaderboard cache

O ranking muda em escala diária, então fica em cache por 6 horas (configurável). O botão
"Refresh board" sempre ignora o cache. Uma falha de download não é fatal: continua-se
usando o último ranking válido e o painel avisa.

## Configuration

| Campo | Padrão | Significado |
| --- | --- | --- |
| `statusRoute` | `/dsh-token-usage` | Prefixo HTTP do painel |
| `sessionsDir` | `''` | Raiz dos logs; vazio significa `$DSH_HOME/sessions` |
| `usageCacheSeconds` | `30` | Cache dos resultados de varredura |
| `rankCacheHours` | `6` | Cache do ranking, em horas |
| `rankScope` | `'catalog'` | `catalog` = todos os modelos chamáveis do host (padrão); `used` = só os usados; `all` = o ranking inteiro |

## Honest reporting

- **Somente loopback**: todos os endpoints aceitam apenas requisições locais de loopback.
- **Sem adivinhar**: modelo sem entrada no ranking mostra "—", não 0; denominador zero
  mostra "—", não 0%.
- **Varredura incompleta avisa**: é marcada como "esta passagem não terminou".
- **O ranking lista só os modelos chamáveis do host** (ou, com `rankScope: used`, os que você usou).

## Design trade-offs

| Decisão | Motivo | Custo |
| --- | --- | --- |
| Fatiar o zstd multi-frame à mão | Um `.zstd` são milhares de frames independentes; `zstdDecompressSync` descomprime só o primeiro e **perde silenciosamente os outros 99%** | Achamos as fronteiras de frame por conta própria |
| Contar só `assistant/message` | `attempt` duplica a medição | `attempt` serve só para deduplicar |
| Nunca ler `totalTokens` | O campo antigo não bate com a soma dos quatro segmentos | Somamos por segmento |
| Cache em memória, sem SQLite | Os logs só crescem; a memória já reduz atualizações a milissegundos | Uma varredura a frio após reiniciar o host |
| Notas de uma API pública | Capacidades devem ser **medidas por outros**, não estimadas | Exige rede; offline reutiliza a última foto |
| Escopo = catálogo chamável do host | Responde "o que posso chamar agora" e segue cada mudança em Plataformas e Modelos | Exige o serviço LlmRuntime do host; sem ele o painel informa honestamente |

## Licence

MIT
