# Raid Icons — Discord → GitHub Issues intake

Poller sin dependencias (Node ≥ 20) que mira el **hilo de tickets** de Cobblemon Raid Icons en Discord
y abre un issue en `manucruzleiva/cobblemon-raid-icons` por cada post nuevo, respondiendo en el thread.
Es el **mismo `poll.mjs`** que los otros cuatro bots: sólo cambia el `User-Agent`.

## Configuración

Todo vive en el repo `intake-bots`; no hay nada que instalar acá.

| | |
|---|---|
| Secrets | `RAID_ICONS_DISCORD_TOKEN`, `RAID_ICONS_GH_TOKEN` |
| Variables | `RAID_ICONS_TICKETS_CHANNEL_ID`, `RAID_ICONS_GH_REPO`, `DISCORD_GUILD_ID` (compartida) |
| Estado | `state.json`, commiteado al repo por el propio workflow |

`DISCORD_GUILD_ID` no es opcional en la práctica: sin ella el bot sólo ve threads archivados, así que
un reporte recién abierto no entra hasta que Discord lo archive.

**El workflow no corre solo hasta que exista el canal.** `RAID_ICONS_TICKETS_CHANNEL_ID` no está
seteada todavía — el foro de tickets de este mod aún no existe en el Discord —, y el job se salta a sí
mismo mientras esa variable esté vacía en vez de fallar cada diez minutos.

## Probar a mano

```bash
gh workflow run intake-raid-icons.yml --repo manucruzleiva/intake-bots
```
