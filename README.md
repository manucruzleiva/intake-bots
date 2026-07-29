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
| [`routes/`](routes/) | Cobblemon Routes | `manucruzleiva/cobblemon-routes` | `poll.mjs` |
| [`picnic/`](picnic/) | Cobblemon Picnic | `manucruzleiva/cobblemon-picnic` | `poll-channels.mjs` |
| [`ditto-hms/`](ditto-hms/) | Cobblemon Ditto HMs | `manucruzleiva/cobblemon-ditto-hms` | `intake.js` |
| [`nuzlocke/`](nuzlocke/) | Cobblemon Nuzlocke | `manucruzleiva/cobblemon-nuzlocke` | pendiente — ver #122 |

Cada proyecto tiene su propio workflow en [`.github/workflows/`](.github/workflows/) (GitHub sólo
lee workflows desde ahí, no desde subcarpetas), su propio estado y sus propios secrets.

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

| Secret | Notas |
|---|---|
| `<PROYECTO>_DISCORD_TOKEN` | Token del bot de Discord |
| `<PROYECTO>_DISCORD_GUILD_ID` | ID del server |
| `<PROYECTO>_DISCORD_BUG_CHANNEL_ID` | Canal foro de bugs |
| `<PROYECTO>_DISCORD_FEATURE_CHANNEL_ID` | Canal foro de features (sólo picnic) |
| `<PROYECTO>_INTAKE_GITHUB_TOKEN` | PAT con scope `repo` sobre el repo privado del mod |

donde `<PROYECTO>` ∈ `ROUTES`, `PICNIC`, `DITTO_HMS`, `NUZLOCKE`.

## Cutover pendiente

Los repos originales (`cobblemon-picnic-bot`, `cobblemon-ditto-hm-community`, `cobblemon-routes-intake`)
siguen activos. Para migrar, por proyecto:

1. Cargar los secrets namespaceados acá.
2. Copiar el archivo de estado (`intake-state.json` / `state.json`) para no re-importar threads viejos.
3. Correr el workflow a mano (`workflow_dispatch`) y verificar que el issue se cree en el repo correcto.
4. Recién ahí, desactivar el workflow del repo viejo.
