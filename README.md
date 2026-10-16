# Intake Bots

Un solo poller que vigila el foro de tickets de cada mod en Discord y abre un issue en el repo de
código correspondiente. Vive en un repo **público** porque GitHub Actions es gratis e ilimitado en
repos públicos y metered en privados — los mods son privados, el bot no.

```
foro de tickets ──(cron */10)──▶  intake.yml (una fila de matrix por proyecto)  ──▶  issue en el repo del mod
```

## Layout

| Ruta | Qué es |
|---|---|
| [`lib/poller.mjs`](lib/poller.mjs) | El poller. Sin dependencias, Node ≥ 20 (CI corre 24) |
| [`lib/matrix.mjs`](lib/matrix.mjs) | Arma la matrix del workflow desde `projects.json` y resuelve los gates |
| [`projects.json`](projects.json) | Un objeto por proyecto: lo único que hay que tocar para dar uno de alta |
| [`.github/workflows/intake.yml`](.github/workflows/intake.yml) | El único workflow |
| `<dir>/state.json` | Ledger de dedup del proyecto. **No se mueve ni se borra**: sin él, cada thread viejo se vuelve a filar |
| `<dir>/reporters.json` | Tally de reporteros para los créditos de la comunidad (aparece con el primer issue filado) |
| [`CREDITS.md`](CREDITS.md) | El registro de créditos, copiado a mano a la wiki |

## Qué hace el poller

Cada post nuevo del foro se vuelve un issue en `<PREFIX>_GH_REPO`, y el bot responde en el thread sin
linkear el repo privado. La respuesta y los labels siguen el **tag del foro** (Bug / Crash / Idea /
Feedback), resuelto por nombre en runtime: no hay ids de tags hardcodeados. Las imágenes se inlinean
y los `.txt`/`.log`/`.json` adjuntos se pliegan en un `<details>` antes de que expire el link del CDN
de Discord. Cuando el issue se cierra en GitHub, el bot lo avisa en el thread, distinguiendo "fixed"
de "not planned".

## projects.json

| Campo | |
|---|---|
| `dir` | Carpeta del proyecto: ahí corre el poller y ahí viven su `state.json` y su `reporters.json` |
| `name` | Nombre de la fila en Actions |
| `prefix` | Prefijo de sus secrets y variables (`DITTO`, no `DITTO_HMS`) |
| `ua` | `User-Agent` hacia Discord y GitHub |
| `skipBeforeId` | Opcional. Snowflake de corte (ver abajo) |
| `gate` | Opcional. `enabled-var` o `channel-set` (ver abajo) |

**Dar de alta un proyecto:** cargar sus secrets y variables, crear la carpeta, agregar el objeto. No
hace falta un workflow nuevo.

### Gates

| Gate | Corre cuando | Quién lo usa |
|---|---|---|
| `enabled-var` | `<PREFIX>_INTAKE_ENABLED == 'true'`, o siempre en un `workflow_dispatch` | nuzlocke |
| `channel-set` | `<PREFIX>_TICKETS_CHANNEL_ID` tiene valor | raid-icons |

Un proyecto con el gate cerrado sigue en la matrix: su fila sale verde con un único step que dice por
qué no corrió.

### skipBeforeId

Picnic lleva `1516437610648834058`, el `lastId` que dejó su bot anterior. Ese bot guardaba una marca
de agua y no la lista de posts, así que no se pudo convertir al `state.json` de este: los snowflakes
son cronológicos y todo lo anterior a esa marca ya estaba importado. Sacarlo re-filaría los posts
archivados del foro.

## Secrets y variables

| Nombre | Tipo | |
|---|---|---|
| `DISCORD_GUILD_ID` | variable | **Compartida**: hay un solo server |
| `<PREFIX>_DISCORD_TOKEN` | secret | Token del bot de Discord |
| `<PREFIX>_GH_TOKEN` | secret | PAT que abre los issues en el repo del mod |
| `<PREFIX>_TICKETS_CHANNEL_ID` | variable | Foro de tickets |
| `<PREFIX>_GH_REPO` | variable | `owner/repo` destino |

`DISCORD_GUILD_ID` no es opcional en la práctica: sin él, `/guilds/{id}/threads/active` no se llama y
el bot **sólo ve threads archivados**, así que un reporte recién abierto no entra hasta que Discord lo
archive.

Los secrets se cargan con `cargar-secrets.ps1` desde la raíz del workspace (`-Auditar` dice qué falta
sin escribir nada). La lista autoritativa está en `Reference/Required Secrets and Variables` del vault.

## Canales

Server: https://discord.gg/SwcwXcCN4k

| Proyecto | Prefijo | Tickets | Anuncios |
|---|---|---|---|
| routes | `ROUTES` | `1519377359290110137` | `1522425693265203331` |
| picnic | `PICNIC` | `1532081390508839083` | `1532081457462513734` |
| ditto-hms | `DITTO` | `1532081100749406218` | `1532081291963531574` |
| nuzlocke | `NUZLOCKE` | `1532081527662313764` | `1532081610034253904` |
| raid-icons | `RAID_ICONS` | `1545050296240046090` | — |

## El workflow

- `plan` lee `projects.json` y los gates; `poll` corre una fila por proyecto con `fail-fast: false`,
  así que un proyecto roto no cancela a los demás.
- Cada fila commitea sólo su `state.json`/`reporters.json` con `[skip ci]`. Como todas pushean al
  mismo branch en el mismo segundo, el push reintenta sobre un `git pull --rebase` hasta cinco veces:
  un state que no llega al repo es un lote de issues duplicados en la corrida siguiente.
- `concurrency: intake` serializa corridas enteras: un dispatch manual espera al cron en curso.
- El cron pide cada 10 minutos; GitHub lo espacia bastante más en la práctica.

## Probar a mano

```bash
gh workflow run intake.yml --repo manucruzleiva/intake-bots
```

El log de cada fila termina en `Done. N new issue(s) filed; M close(s) announced; K threads tracked.`
