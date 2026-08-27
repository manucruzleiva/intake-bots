# Intake Bots

Un bot de intake **por proyecto**: cada uno vigila los foros de Discord de su mod y abre issues en el
repo de código correspondiente. Todos viven acá, en un repo **público**, porque GitHub Actions es
gratis e ilimitado en repos públicos y metered en privados — los mods son privados, los bots no.

```
#bugs / #features  ──(cron 5 min)──▶  intake-bots (Actions)  ──▶  issues en el repo del mod
```

## Layout

| Carpeta | Proyecto | Repo destino de los issues | Script |
|---|---|---|---|
| [`routes/`](routes/) | Routes | `manucruzleiva/routes` | `poll.mjs` |
| [`picnic/`](picnic/) | Cobblemon Picnic | `manucruzleiva/cobblemon-picnic` | `poll-channels.mjs` |
| [`ditto-hms/`](ditto-hms/) | Cobblemon Ditto HMs | `manucruzleiva/cobblemon-ditto-hms` | `intake.js` |
| [`nuzlocke/`](nuzlocke/) | Cobblemon Nuzlocke | `manucruzleiva/cobblemon-nuzlocke` | pendiente — ver #122 |
| [`raid-icons/`](raid-icons/) | Cobblemon Raid Icons | `manucruzleiva/cobblemon-raid-icons` | `poll.mjs` |

Cada proyecto tiene su propio workflow en [`.github/workflows/`](.github/workflows/) (GitHub sólo
lee workflows desde ahí, no desde subcarpetas), su propio estado y sus propios secrets.

## Un solo hilo de tickets por proyecto

El Discord cambió de metodología: **ya no hay canal de features**, sólo un hilo de tickets por
proyecto. Los canales son:

| Proyecto | Tickets | Anuncios |
|---|---|---|
| routes | `1519377359290110137` | `1522425693265203331` |
| picnic | `1532081390508839083` | `1532081457462513734` |
| ditto-hms | `1532081100749406218` | `1532081291963531574` |
| nuzlocke | `1532081527662313764` | `1532081610034253904` |
| raid-icons | *(sin crear)* | *(sin crear)* |

Server: https://discord.gg/SwcwXcCN4k

**Raid Icons todavía no tiene canales.** Su workflow existe y está en el cron como los demás, pero se
salta a sí mismo mientras `RAID_ICONS_TICKETS_CHANNEL_ID` esté vacía: un cron cada diez minutos contra
un canal inexistente es una corrida roja cada diez minutos. Se crea el foro, se setea la variable, y
el guard se vuelve cierto solo.

**Los pollers de picnic y ditto-hms siguen esperando dos ids** (bugs + features) porque no se tocó su
código. Los workflows setean **sólo el de bugs** y dejan el de features vacío a propósito: los dos
scripts descartan el canal ausente (`.filter((c) => c.id)` en picnic, `if (FEATURE_CHANNEL)` en
ditto), así que hacen una sola pasada.

> ⚠️ **No apuntar los dos ids al mismo canal.** El estado se guarda por *kind*, no por canal, así que
> el mismo thread se importaría dos veces — una como `[Bug]` y otra como `[Feature]`, con `lastId`
> independientes. Duplica cada issue.

Consecuencia: todo ticket entra etiquetado `bug` + `discord`. El triage a `enhancement` se hace en el
issue, no en el intake.

## Las tres implementaciones NO están unificadas

Son tres pollers que evolucionaron por separado (175 / 244 / 152 líneas, ~408 líneas de diferencia
entre los dos más grandes). Se consolidó la **ubicación**, no el código: unificarlos es un refactor
aparte, con riesgo propio, sobre código que ya está en producción hablando con Discord y GitHub.

Diferencias reales que habría que reconciliar antes de unificar:

- **`picnic/`** — dos canales (bugs + features) y `reporters.json`, un tally por reportero que la wiki
  lee para generar la página de créditos de la comunidad. Es el único con esa feature.
- **`routes/`** — inlinea imágenes y pliega `.txt`/`.log`/`.json` (crash reports) en un `<details>`
  antes de que expire el link del CDN de Discord. Responde "tracked ✅" en el thread.
- **`ditto-hms/`** — el más simple; forum polling directo sin adjuntos ni tallies.

## Secrets

Al vivir todos en un repo, los secrets se namespacean por proyecto. **Esta migración todavía no está
hecha** — los bots viejos siguen corriendo en sus repos originales hasta que se haga el cutover.

| Nombre | Tipo | Notas |
|---|---|---|
| `DISCORD_GUILD_ID` | **variable** | **Compartida** — hay un solo server, y un guild id no es sensible |
| `<P>_DISCORD_TOKEN` | secret | Token del bot de Discord |
| `<P>_GH_TOKEN` | secret | PAT que abre los issues en el repo del mod |
| `<P>_TICKETS_CHANNEL_ID` | **variable** | Hilo de tickets — un id de canal no es sensible |
| `<P>_GH_REPO` | **variable** | `owner/repo` destino |

donde `<P>` ∈ `ROUTES`, `PICNIC`, `DITTO`, `NUZLOCKE`, `RAID_ICONS`. Los nombres exactos de env var que espera cada
script varían (no se unificaron los pollers); cada workflow hace el mapeo.

> **Unificados el 2026-07-30.** Había **tres** nombres distintos para el token de GitHub
> (`_ISSUES_REPO_TOKEN`, `_MOD_REPO_TOKEN`, `_INTAKE_GITHUB_TOKEN`) y **dos** para el de Discord
> (`_DISCORD_TOKEN`, `_DISCORD_BOT_TOKEN`); el repo destino salía de una variable en tres bots y de un
> literal en el de ditto; y el prefijo de ditto era `DITTO_HMS_`. Se pudo renombrar sin migrar nada
> porque el repo todavía estaba en 0 secrets y 0 variables.

> ⚠️ **`DISCORD_GUILD_ID` no es opcional**, aunque `routes/poll.mjs` lo diga. Sin él,
> `/guilds/{id}/threads/active` no se llama y el bot **sólo ve threads archivados**: un reporte recién
> abierto no entra hasta que Discord lo archive, o nunca si la gente lo sigue respondiendo. El
> comentario del script dice *"otherwise derived per thread"* y nada lo deriva. En `ditto-hms` es
> directamente obligatorio: `intake.js` aborta si falta. Sólo `picnic` no lo usa.

## Cutover pendiente

Los repos originales (`cobblemon-picnic-bot`, `cobblemon-ditto-hm-community`, `cobblemon-routes-intake`)
siguen activos. Para migrar, por proyecto:

1. Cargar los secrets namespaceados acá.
2. Copiar el archivo de estado (`intake-state.json` / `state.json`) para no re-importar threads viejos.
3. Correr el workflow a mano (`workflow_dispatch`) y verificar que el issue se cree en el repo correcto.
4. Recién ahí, desactivar el workflow del repo viejo.
