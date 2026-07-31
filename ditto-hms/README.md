# Ditto HMs — Discord → GitHub Issues intake

Poller sin dependencias (Node ≥ 20) que mira el **hilo de tickets** de Cobblemon Ditto HMs en Discord y
abre un issue en `manucruzleiva/cobblemon-ditto-hms` por cada post nuevo, respondiendo en el thread. Es el
**mismo `poll.mjs`** que routes y nuzlocke: sólo cambia el `User-Agent`.

## Por qué cambió

Hasta 2026-07-31 este proyecto tenía su propio bot, `bot/intake.js`: CommonJS, `require("https")` en vez de
`fetch`, estado en el cache de Actions en vez del repo, y otros nombres de variables de entorno.

Ese bot **nunca importó nada**. Pedía `GET /channels/{id}/threads`, que no es un endpoint de Discord: la API
respondía **405**, el `catch` de `processChannel` se lo tragaba con un `console.warn`, y la corrida terminaba
en verde con "Done. Tracked threads: 0". Por eso los issues de este repo están todos escritos a mano.

Los posts abiertos de un foro se listan a nivel servidor (`/guilds/{id}/threads/active`) y se filtran por
`parent_id` — que es lo que el poller estándar ya hacía.

## Configuración

Todo vive en el repo `intake-bots`; no hay nada que instalar acá.

| | |
|---|---|
| Secrets | `DITTO_DISCORD_TOKEN`, `DITTO_GH_TOKEN` |
| Variables | `DITTO_TICKETS_CHANNEL_ID`, `DITTO_GH_REPO`, `DISCORD_GUILD_ID` (compartida) |
| Estado | `state.json`, commiteado al repo por el propio workflow |

`DISCORD_GUILD_ID` no es opcional en la práctica: sin ella el bot sólo ve threads archivados, así que un
reporte recién abierto no entra hasta que Discord lo archive.

## Probar a mano

```bash
gh workflow run intake-ditto-hms.yml --repo manucruzleiva/intake-bots
```

Para chequear que el bot vea y pueda escribir en los canales, desde la raíz del workspace:

```powershell
.\probar-discord.ps1            # ve los 8 canales
.\probar-discord.ps1 -Escribir  # prueba escritura real en los de anuncios
.\probar-discord.ps1 -Listar    # cuenta posts abiertos por foro
```
