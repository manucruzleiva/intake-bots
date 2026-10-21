# Arquitectura — el alcance ampliado

> **Estado: propuesta.** Este documento acompaña al nuevo [`GOAL.MD`](GOAL.MD) y planifica cómo
> llega el bot ahí. No describe código que ya existe salvo donde lo dice; el [README](README.md) sigue
> siendo la referencia de lo que corre hoy. Nada de la sección *Fases* se implementa sin un OK.

El bot deja de ser sólo intake. Tiene cuatro pilares, y cada uno sigue las mismas reglas que el
intake ya probó: **fuente declarada en un repo → reconciliador idempotente → dry run por defecto →
falla visible en el healthcheck**.

| Pilar | Fuente de verdad | Escribe en | Hoy |
|---|---|---|---|
| 1. Intake | `#tickets` + `projects.json` | issues de cada mod, hilos de Discord, Linear | ✅ completo |
| 2. Server de Discord | `server.json` | el guild | 🟡 reconciliador manual, sin detección de drift |
| 3. Publicación de versiones | `CHANGELOG.md` del mod en su tag + `projects.json.announce` | `#announcements` | 🟡 existe, pero 4 de 9 mods no lo usan |
| 4. Páginas de tienda | `DESCRIPTION.md`, `DESCRIPTION_SHORT.txt`, `art/gallery/` del mod | Modrinth (API), CurseForge (a mano) | 🔴 copiado en cada `publish.yml` |

## Lo que encontré al relevar los repos (2026-10-21)

Esto es deuda real, no hipotética, y la fase 0 la salda:

1. **`announce.yml` no existe en intake-bots, y tres mods lo llaman.** `routes`, `cobblemon-nuzlocke`
   y `cobblemon-champions-training` tienen un job `uses: manucruzleiva/intake-bots/.github/workflows/announce.yml@main`.
   El camino vigente es el `repository_dispatch` `mod-released` (#54), que ya usan ditto-hms,
   mid-battle-exp, picnic, raid-icons y tree-carve. En esos tres el job de anuncio falla al resolver
   el workflow, y su release nunca llega a `#announcements` — y por #53, **tampoco se avisa a los
   reporters**, porque `releases.mjs` espera ver la card.
2. **`cobblemon-action-combat` postea en Discord por su cuenta**, con `DISCORD_TOKEN` y
   `DISCORD_ANNOUNCE_CHANNEL_ID` propios: un segundo formato de card y un token del bot fuera de este
   repo.
3. **El sync de la descripción está copiado en los 9 `publish.yml`** (~17 líneas cada uno, con
   variantes: picnic reescribe `metadata_src`). Cada mod tiene su `MODRINTH_TOKEN` con escritura de
   proyecto. La galería ya está centralizada (`gallery.yml`), pero sólo picnic la adoptó.
4. **`announce.mjs` no tiene dedup**: un segundo dispatch de la misma versión postea una segunda card.
   El grupo de concurrencia por versión evita dos a la vez, no dos seguidas.
5. **`server.yml` sólo corre a mano.** Un cambio hecho a mano en el guild no se ve hasta el próximo
   dry run que alguien lance.

## Principios que se mantienen (y cómo se aplican a lo nuevo)

- **Datos, no código.** Un mod nuevo es una entrada en `projects.json` y sus archivos en el repo del
  mod. Ningún pilar lleva un `if (project === …)`.
- **Idempotencia por lectura del estado vivo**, no por confianza en un ledger: como `server.mjs` y
  `catalog.mjs`, cada módulo nuevo lee lo publicado, compara y escribe sólo la diferencia. Donde la
  plataforma no deja comparar (el contenido de un post viejo, CurseForge), un ledger en el repo.
- **No se le cree al caller.** Un `repository_dispatch` de un mod sólo dice *qué* mirar; el contenido
  se lee por la API en el commit/tag que corresponde, como ya hace `announce.mjs`.
- **Credenciales por superficie.** Cada token vive en un solo lugar y con el mínimo scope (tabla
  abajo). Un repo de mod no tiene ningún token que escriba en Discord ni en la página de la tienda.
- **Dry run por defecto, `prune` explícito.** Vale igual para canales, imágenes de galería o links.
- **Una falla que no se ve no existe.** Cada pilar suma sus chequeos a `health.mjs` y su sección a la
  página de estado.

## Pilar 2 — Server de Discord

Ya existe: `server.json` + `lib/server.mjs` + `server.yml` (manual), `lib/bootstrap.mjs`, el rol
`Bug Catcher`, el catálogo de `#mods`, los mensajes fijos de `#rules` y el post fijado de `#tickets`.

Lo que falta:

| Pieza | Qué hace | Dónde |
|---|---|---|
| **Drift diario** | `server.yml` gana un `schedule` diario en **dry run**. Si el diff no es `nothing to do`, `health.mjs` abre/edita un issue "Discord drift" con el diff, y lo cierra cuando vuelve a coincidir (un `--export` + commit o un apply). Nunca aplica solo | `server.yml`, `health.mjs` |
| **Canales por proyecto desde `projects.json`** | Hoy `bootstrap.mjs` escribe tag, rol y opción de onboarding en `server.json` a mano. Pasa a ser un paso de validación en CI: un proyecto con intake sin su tag/rol/opción en `server.json` es una fila roja con el comando que lo arregla | `bootstrap.mjs --check` |
| **Housekeeping de foros** | Archivar hilos de los foros declarados en `server.json` sin actividad en N días y sin issue abierto ni poll (el intake ya archiva los cerrados); nunca borrar | `lib/housekeeping.mjs`, en el intake |
| **Bitácora de moderación** | AutoMod ya alerta en `#moderator-only`. Se suma un resumen semanal (cuántas alertas, de qué regla) en ese canal. El bot **no** banea, timeoutea ni borra mensajes de miembros: eso es juicio humano (ver *Boundaries*) | `lib/modlog.mjs`, `schedule` semanal |
| **Permisos del bot** | Hoy el bot es Administrator. Se declara en `server.json` el set mínimo (Manage Roles/Channels/Threads/Messages, Send Messages/Polls, Create Public Threads, Manage Guild para onboarding/AutoMod) y el drift lo avisa si sobra | `server.json` |

## Pilar 3 — Publicación de versiones

Ya existe: `lib/announce.mjs`, `mod-released.yml`, `lib/releases.mjs` (aviso al reporter) y
`lib/survey.mjs`.

Lo que falta:

1. **Un solo camino para todos.** Los 4 mods de arriba pasan al dispatch `mod-released` con
   `INTAKE_DISPATCH_TOKEN`, y se les borra `DISCORD_TOKEN` y `DISCORD_ANNOUNCE_CHANNEL_ID`. Los
   `announce` que faltan en `projects.json` se agregan.
2. **Dedup de cards.** Antes de postear, `announce.mjs` lee los últimos mensajes del bot en
   `#announcements` y busca el encabezado de esa versión — la misma regla con la que `releases.mjs`
   ya reconoce la card. Si está, la **edita** en el lugar (corrige un changelog) en vez de postear otra.
   Un `--force-new` explícito para el caso raro.
3. **Crosspost.** `#announcements` es tipo Announcement: la card se publica (*crosspost*) a los
   servers que siguen el canal. Un paso más, idempotente (`flags & CROSSPOSTED`).
4. **Opcional, a decidir:** un hilo por release bajo la card para feedback de esa versión, que el
   intake trata como `#tickets` con el tag del mod ya puesto.

Lo que **no** entra: subir jars ni crear versiones en las tiendas. Eso necesita el build y sigue en
el `publish.yml` de cada mod, con su `MODRINTH_TOKEN`/`CURSEFORGE_TOKEN` de *upload*.

## Pilar 4 — Páginas de tienda

La pieza nueva grande. Centraliza lo que hoy está copiado en 9 `publish.yml`, igual que se hizo con
el anuncio.

```
repo del mod                          intake-bots                              tiendas
DESCRIPTION.md ─┐   push a main que    ┌──────────────────────────┐
DESCRIPTION_    ├── toca esos archivos ─▶ store.yml (dispatch       │── PATCH body/summary/links ─▶ Modrinth
  SHORT.txt     │   (o el publish)     │   `store-sync`) ─────────▶│── gallery.mjs ──────────────▶ Modrinth gallery
art/gallery/  ──┘                      │   lib/store.mjs           │
                                       │                           │── diff ─▶ issue "CurseForge page out of date"
                 catalog.yml (cada h) ─▶  --check (sólo lectura) ───│          en el repo del mod (checklist a mano)
                                       └──────────────────────────┘
```

**`lib/store.mjs`** — para un proyecto de `projects.json`:

| Campo de Modrinth | Fuente | Nota |
|---|---|---|
| `body` | `DESCRIPTION.md` del mod, en el commit pedido | con la reescritura `metadata_src=curseforge → modrinth` que hoy hace picnic, generalizada |
| `description` (summary) | `DESCRIPTION_SHORT.txt` | ≤ 256 caracteres; más largo es error, no truncado |
| `issues_url`, `source_url`, `wiki_url`, `discord_url`, `donation_urls` | `projects.json.store.links` (+ `announce.links.wiki`/`sponsor`, sin duplicar) | `issues_url` apunta al canal `#tickets`, nunca al repo privado |
| `license` | `LICENSE` del mod → `license.url` | el `id` (`LicenseRef-…`) se declara en `projects.json` |
| galería | `art/gallery/gallery.json` | reusa `lib/gallery.mjs` tal como está |
| categorías, loaders, versiones de MC del proyecto | `projects.json.store.categories` | opcional; sin la clave no se toca |

- **Idempotente por comparación:** lee el proyecto de Modrinth, compara campo por campo y manda un
  solo `PATCH` con lo que difiere. Nada distinto, ninguna escritura.
- **Disparo:** un `repository_dispatch` `store-sync` `{project, ref}` desde el mod (un workflow chico,
  `on: push` a `main` con `paths:` sobre esos archivos, más el paso del publish), con el mismo
  `INTAKE_DISPATCH_TOKEN` que ya existe. intake-bots lee los archivos **en ese `ref`** con `GH_TOKEN`,
  y sólo si `ref` es un commit de la rama por defecto.
- **Drift:** `catalog.yml` ya baja el proyecto de Modrinth cada hora; suma `store.mjs --check`, que
  compara sin escribir y deja el resultado en `status.json`. Un drift de más de 24 h es un chequeo
  rojo del healthcheck.
- **CurseForge no tiene API de descripción ni de galería.** El bot no puede escribir ahí, así que
  lleva la cuenta: guarda en `<dir>/store.json` el sha256 del `DESCRIPTION.md` y de cada imagen que
  ya se pegaron a mano en CurseForge. Cuando cambian, abre (o edita) en el repo del mod **un** issue
  "CurseForge page out of date" con el texto listo para pegar y las imágenes a subir, como checklist.
  Se cierra marcando la checklist o comentando `/done`, que actualiza los hashes. Si cfwidget devuelve
  la descripción, se usa como verificación adicional, nunca como fuente.

## Configuración (`projects.json`)

Se agrega un bloque opcional por proyecto; sin él, el pilar 4 se saltea ese proyecto con un aviso
(adopción gradual, como la galería):

```json
"store": {
  "modrinth": "cobblemon-picnic",
  "curseforge": 1234567,
  "license": "LicenseRef-If-You-Make-Money",
  "links": { "source": null, "discord": "https://discord.gg/SwcwXcCN4k" },
  "categories": ["adventure", "game-mechanics"],
  "rewriteSrc": true
}
```

`modrinth`/`curseforge` reemplazan a las variables `MODRINTH_PROJECT_ID`/`CURSEFORGE_PROJECT_ID` que
hoy vive en cada repo de mod sólo para el sync de descripción (el publish las sigue usando para subir).

## Credenciales

| Secret | Dónde | Scope | Cambio |
|---|---|---|---|
| `DISCORD_TOKEN` | **sólo** intake-bots | el bot único; permisos mínimos declarados en `server.json` | se borra de routes, nuzlocke, champions-training y action-combat |
| `MODRINTH_STORE_TOKEN` | intake-bots | PAT de Modrinth con **sólo** `PROJECT_WRITE` + `PROJECT_READ` (sin `VERSION_*`) | nuevo; los repos de mod conservan su `MODRINTH_TOKEN` de upload, que ya no necesita `PROJECT_WRITE` |
| `INTAKE_DISPATCH_TOKEN` | cada mod | fine-grained, sólo intake-bots, Contents: read/write | sin cambio; ahora también dispara `store-sync` |
| `GH_TOKEN` | intake-bots | ya lee los repos de mod | además abre el issue de CurseForge en el repo del mod (Issues: write, ya lo tiene) |
| `CURSEFORGE_TOKEN` | cada mod | upload | sin cambio; no sirve para la página |

Un Modrinth PAT es por usuario, no por proyecto: `PROJECT_WRITE` alcanza a todos los proyectos del
autor. Por eso vive en un solo repo, el del bot, y no en nueve.

## Observabilidad

`health.mjs` pasa de "intake sano" a "superficies sanas". Chequeos nuevos:

| Chequeo | Problema cuando |
|---|---|
| Discord drift | el dry run diario de `server.yml` no da `nothing to do` |
| Card faltante | un release publicado de un mod con `announce` no tiene card en `#announcements` a las 6 h (hoy es un `::warning::` en `releases.mjs`) |
| Store drift | Modrinth difiere de la fuente más de 24 h |
| CurseForge pendiente | el issue "CurseForge page out of date" lleva más de 7 días abierto (amarillo, no rojo) |

La página de estado suma una tabla por proyecto: última card, estado de la página de Modrinth y
pendientes de CurseForge.

## Fases

| Fase | Contenido | Toca repos de mod | Tamaño |
|---|---|---|---|
| **0. Saldar deuda** | Migrar routes, nuzlocke, champions-training y action-combat al dispatch `mod-released`; dedup en `announce.mjs`; re-anunciar con `announce_only` las versiones que se perdieron | sí (4 `publish.yml`) | chico |
| **1. Store sync en Modrinth** | `lib/store.mjs`, `store.yml`, bloque `store` en `projects.json`, `MODRINTH_STORE_TOKEN`; reemplazar el bloque copiado de cada `publish.yml` por el dispatch | sí (9 `publish.yml`) | medio |
| **2. CurseForge asistido** | `<dir>/store.json`, el issue con checklist, `/done` | no | chico |
| **3. Drift y health** | `server.yml` diario, `store.mjs --check` en `catalog.yml`, chequeos nuevos y página de estado | no | medio |
| **4. Discord extendido** | permisos mínimos, `bootstrap.mjs --check`, housekeeping, resumen de moderación, crosspost | no | medio |

Cada fase es su propio PR; la 0 primero porque hoy hay releases que no se anuncian.

## Decisiones abiertas

1. **¿El store sync corre en cada push a `main` del mod o sólo con el release?** Propuesta: en cada
   push que toca los archivos de tienda, porque una corrección de texto no debería esperar una versión.
2. **¿Hilo de feedback por release?** (pilar 3, punto 4). Útil para los primeros días de una versión,
   pero suma un segundo lugar donde reportar.
3. **¿Housekeeping archiva hilos de usuarios?** Archivar no borra y el usuario lo reabre escribiendo,
   pero cambia lo que ve la lista del foro.
