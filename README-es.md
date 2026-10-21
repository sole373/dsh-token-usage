# dsh-token-usage

> Analítica de consumo de tokens y clasificación de capacidades de modelos para DeepSeek Harness — un plugin.

[English](README.md) | [中文](README-zh.md) | Español | [Português](README-pt.md) | [हिन्दी](README-hi.md)

## What it does

Este plugin analiza **los registros de sesión que el propio host escribe**, agrupa las
entradas por proveedor y modelo, y muestra tendencias de consumo, tasa de acierto de
caché y el reparto de uso entre modelos. Después contrasta **los modelos que usted
realmente usó** con una clasificación pública de capacidades.

| Capacidad | Punto de entrada |
| --- | --- |
| Panel de consumo | «Token usage» en la barra lateral → panel principal |
| JSON de consumo | `GET {prefix}/usage` (admite `days=` y `refresh=1`) |
| Clasificación de modelos | Parte inferior del panel de consumo |
| JSON de clasificación | `GET {prefix}/model-rank` (admite `refresh=1`) |

**Este plugin nunca toca sus cuentas.** Solo lee los registros de sesión del propio
host: no lanza ningún flujo OAuth, no copia credenciales, no registra proveedores de
modelos ni modifica ningún cliente.

## How it relates to `dsh-agent-checkin`

**Sin relación alguna.** Los dos plugins son independientes y se pueden instalar por
separado. El panel de consumo vivió dentro de `dsh-agent-checkin` hasta la 0.8.0; desde
la 0.9.0 es un plugin aparte: no comparten código, ni archivos de caché, ni se llaman
entre sí.

| | `dsh-agent-checkin` | `dsh-token-usage` |
| --- | --- | --- |
| Qué hace | Chec-in diario, saldos de créditos, clientes locales como proveedores de modelos | Analítica de consumo y clasificación de capacidades |
| Fuente de datos | El estado de sesión de los clientes locales | Los registros de sesión del propio host |
| ¿Lee archivos del otro? | —— | **No** |

## Requirements

- DeepSeek Harness (`dsh`) 0.1.7 o posterior, con interfaz web en la combinación
- Node.js `^22.19.0 || >=24.0.0`
- Un registro de sesión local legible (por defecto `$DSH_HOME/sessions`, o `~/.dsh/sessions`)

## Installation

```bash
dsh plugin add dsh-token-usage
```

O añada una línea al `cordis.patch.yml` del perfil:

```yaml
- id: dsh-token-usage
  name: dsh-token-usage
```

## Usage

### The usage panel

El panel muestra, de arriba abajo: cifras resumen (consumo total / hoy / últimos 7 días /
número de llamadas, más aciertos de caché, fallos y tasa de acierto), cuatro gráficos
(tendencia de consumo, reparto por proveedor, modelos más usados y capacidad de los
modelos que usted usó), una tabla de detalle por origen, la clasificación de modelos con
recomendaciones por tarea (programación / razonamiento / agéntico / contexto largo /
visión / mejor relación calidad-precio) y un pie con el coste real del escaneo.

La ventana de tiempo puede ser de 7 / 30 / 90 días o «todo». «Refresh» fuerza un
reeescaneo; el resto usa la caché.

### How the numbers are computed

| Métrica | Definición |
| --- | --- |
| Tokens por registro | `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`, sumados por separado |
| Denominador de la tasa de acierto | `input + cacheRead + cacheWrite` (**sin output**: lo generado no es lo que se alimentó) |
| Denominador cero | Muestra «—», **no 0 %** |
| Corte de día | Zona horaria local, no UTC |
| «Total» | Todo el histórico; las tres cifras de caché usan la misma base |

> **Por qué no el campo `totalTokens`**: es una medida antigua y no coincide necesariamente
> con la suma de los cuatro segmentos. Toda cifra de la página se suma por segmentos.
>
> **Por qué solo `assistant/message`**: `assistant/attempt` guarda una copia de la misma
> medición de uso; contar ambos duplicaría el total.

### The incremental cache

Los registros de sesión solo crecen, así que no hace falta reescanearlo todo. El
escáner anota `size + mtime` de cada archivo y solo vuelve a leer los que cambiaron.

- Escaneo completo en frío: unos cuantos registros / decenas de MB, ~1,4 s
- Actualizaciones habituales: milisegundos de un solo dígito con la caché caliente
- Sin SQLite: sin dependencias nativas, sin migraciones de esquema, sin estados a medias

### The model leaderboard

Dos fuentes, estrictamente separadas: las **puntuaciones de capacidad** vienen de una
clasificación pública (la API `/api/v1/models` de OpenRouter, sin autenticación, con los
índices intelligence / coding / agentic de Artificial Analysis), y el **alcance** son los
modelos que aparecen de verdad en sus registros de sesión.

> ⚠️ **Declaración de alcance (impresa en el panel, no escondida)**: la clasificación solo
> responde «qué puntuación tiene este modelo», **no** «tiene usted derecho a llamarlo».

### Leaderboard cache

La clasificación cambia a escala diaria, así que se cachea 6 horas (configurable). El
botón «Refresh board» siempre ignora la caché. Un fallo de descarga no es fatal: se sigue
usando la última clasificación correcta y el panel lo indica.

## Configuration

| Campo | Por defecto | Significado |
| --- | --- | --- |
| `statusRoute` | `/dsh-token-usage` | Prefijo HTTP del panel |
| `sessionsDir` | `''` | Raíz de los registros; vacío significa `$DSH_HOME/sessions` |
| `usageCacheSeconds` | `30` | Caché de resultados de escaneo |
| `rankCacheHours` | `6` | Caché de la clasificación, en horas |
| `rankScope` | `'used'` | `used` = solo los modelos usados; `all` = la clasificación entera |

## Honest reporting

- **Solo loopback**: todos los endpoints aceptan únicamente peticiones locales de loopback.
- **Sin adivinar**: un modelo sin entrada en la clasificación muestra «—», no 0; un
  denominador de cero muestra «—», no 0 %.
- **Los escaneos incompletos lo dicen**: se marcan como «esta pasada no terminó».
- **La clasificación solo lista los modelos que usted usó**.

## Design trade-offs

| Decisión | Motivo | Coste |
| --- | --- | --- |
| Trocear el zstd multi-frame a mano | Un `.zstd` son miles de frames independientes; `zstdDecompressSync` descomprime solo el primero y **pierde el otro 99 % en silencio** | Buscamos los límites de frame por nuestra cuenta |
| Contar solo `assistant/message` | `attempt` duplica la medición | `attempt` solo sirve para deduplicar |
| Nunca leer `totalTokens` | El campo antiguo no cuadra con la suma de los cuatro segmentos | Sumamos por segmentos |
| Caché en memoria, sin SQLite | Los logs solo crecen; la memoria ya baja las actualizaciones a milisegundos | Un escaneo en frío tras reiniciar el host |
| Puntuaciones de una API pública | Las capacidades deben ser **medidas por otros**, no estimadas | Requiere red; sin red se reutiliza la última instantánea |
| Alcance = llamadas observadas | Misma base que la tarjeta de capacidad y sin depender de ningún otro plugin | Los modelos instalados pero nunca usados no aparecen |

## Licence

MIT
