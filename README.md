# Intake Bots

Un solo poller que vigila los foros de tickets de Discord (el único, con un tag por mod, y el viejo de
cada mod) y abre un issue en el repo de código correspondiente. Vive en un repo **público** porque GitHub Actions es gratis e ilimitado en
repos públicos y metered en privados — los mods son privados, el bot no.

```
foro de tickets ──▶  intake.yml (una fila de matrix por proyecto)  ──▶  issue en el repo del mod
                         │  ▲
                    next ▼  │ dispatch trigger=scheduler
                     intake-pacer.yml (espera 10 min en el environment intake-pacing)
```

## Layout

| Ruta | Qué es |
|---|---|
| [`lib/poller.mjs`](lib/poller.mjs) | El poller. Sin dependencias, Node ≥ 20 (CI corre 24) |
| [`lib/bootstrap.mjs`](lib/bootstrap.mjs) | Agrega un mod a `server.json`: su tag en `#tickets`, su rol y su opción de onboarding. Imprime lo que queda a mano |
| [`lib/replies.mjs`](lib/replies.mjs) | El otro sentido: un comentario del issue que empieza con `/reply` se postea en el hilo del reporter |
| [`lib/releases.mjs`](lib/releases.mjs) | Le avisa a cada reporter, en su hilo, el día que sale el release con su fix |
| [`lib/survey.mjs`](lib/survey.mjs) | La encuesta de satisfacción: el poll de ese aviso, y qué hace el voto del reporter |
| [`lib/linear.mjs`](lib/linear.mjs) | Planifica el espejo de Linear de un issue: project, prioridad por tipo y `Backlog`, sólo lo vacío |
| [`lib/metrics.mjs`](lib/metrics.mjs) | Las métricas de intake de cada proyecto, en el job summary de su fila |
| [`lib/unrouted.mjs`](lib/unrouted.mjs) | Los posts del foro único sin tag de mod: les pide el tag una vez y no fila nada |
| [`lib/matrix.mjs`](lib/matrix.mjs) | Arma la matrix del workflow desde `projects.json` |
| [`lib/gates.mjs`](lib/gates.mjs) | Los gates: qué proyecto corre y por qué. Lo usan `matrix.mjs` y `health.mjs` |
| [`lib/health.mjs`](lib/health.mjs) | El healthcheck: lee las corridas de `intake.yml` y abre/cierra el issue "Intake unhealthy" |
| [`lib/announce.mjs`](lib/announce.mjs) | La card de un release en `#announcements`. Lo corre `mod-released.yml`; valida el release y lee el CHANGELOG del mod en su tag por la API; `--print` muestra el payload sin postear |
| [`lib/catalog.mjs`](lib/catalog.mjs) | El catálogo de `#mods`: una card por proyecto con los datos vivos de Modrinth y CurseForge, editada en el lugar. `--dry-run` imprime sin escribir |
| [`lib/stats.mjs`](lib/stats.mjs) | Los snapshots de descargas: con lo que bajó el catálogo, agrega una fila por mod cuyo total se movió a `stats/downloads.json` de la rama `stats` |
| [`lib/status-page.html`](lib/status-page.html) | La página de estado en GitHub Pages; lee el `status.json` que escribe `health.mjs` y el `backlog.json` |
| [`lib/backlog.mjs`](lib/backlog.mjs) | La tabla de tickets abiertos de la página: cuenta los issues abiertos de cada mod por tipo, estado, prioridad y origen |
| [`lib/server.mjs`](lib/server.mjs) | El reconciliador del server de Discord contra `server.json`. Dry run por defecto; `--export` vuelca el guild vivo |
| [`server.json`](server.json) | **El server de Discord entero**: roles, categorías, canales, overwrites, tags de foro, mensajes fijos del bot (`#rules`), AutoMod, welcome screen y onboarding |
| [`projects.json`](projects.json) | Un objeto por proyecto: lo único que hay que tocar para dar uno de alta |
| [`.github/workflows/intake.yml`](.github/workflows/intake.yml) | El único workflow de intake |
| [`.github/workflows/intake-pacer.yml`](.github/workflows/intake-pacer.yml) | Le pone cadencia: espera 10 min y vuelve a disparar `intake.yml` |
| [`.github/workflows/healthcheck.yml`](.github/workflows/healthcheck.yml) | El healthcheck desde afuera de la cadena, por `schedule`: ve si la cadena se cortó |
| [`.github/workflows/server.yml`](.github/workflows/server.yml) | A mano: hace que el guild coincida con `server.json` (`dry_run` por defecto, `prune` apagado) |
| [`.github/workflows/catalog.yml`](.github/workflows/catalog.yml) | Cada hora: corre `lib/catalog.mjs` y pushea el snapshot de descargas a la rama `stats`. Aparte de `intake.yml`, para que una tienda caída no toque la cadena |
| [`.github/workflows/mod-released.yml`](.github/workflows/mod-released.yml) | `repository_dispatch` `mod-released`: el `publish.yml` de cada mod lo dispara cuando las tiendas aceptaron los jars, y postea la card. A mano, con `dry` (por defecto), valida e imprime sin postear |
| `unrouted.json` | Los posts del foro único a los que ya se les pidió el tag de mod |
| `<dir>/state.json` | Ledger de dedup del proyecto. **No se mueve ni se borra**: sin él, cada thread viejo se vuelve a filar |
| `<dir>/reporters.json` | Tally de reporteros para los créditos de la comunidad y el rol `Bug Catcher` (aparece con el primer issue filado) |
| `<dir>/satisfaction.json` | Resultados de la encuesta: `{ issue, version, vote, at }` por poll respondido o vencido (aparece con el primero) |
| [`CREDITS.md`](CREDITS.md) | El registro de créditos, copiado a mano a la wiki |

## Qué hace el poller

Cada post nuevo del foro se vuelve un issue en `<PREFIX>_GH_REPO`, y el bot responde en el thread sin
linkear el repo privado. La respuesta y los labels siguen el **tag del foro** (Bug / Crash / Idea /
Feedback), resuelto por nombre en runtime: no hay ids de tags hardcodeados. Las imágenes se inlinean
y los `.txt`/`.log`/`.json` adjuntos se pliegan en un `<details>` antes de que expire el link del CDN
de Discord. Cuando el issue se cierra en GitHub, el bot lo avisa en el thread, distinguiendo "fixed"
de "not planned".

**Needs info** (#10, `lib/completeness.mjs`): a un Bug o Crash, la respuesta le pide sólo lo que le
falta — la versión (algo como `1.21.1`), el loader (`fabric`/`neoforge`) y, si es un Crash, el log
(un adjunto `.log`/`.txt` o un link de mclo.gs/pastebin) —, leído del post y de los mensajes del
reporter. Un log adjunto cubre los tres: dice versión y loader en sus primeras líneas. Si falta algo,
el issue lleva `needs-info` (el bot crea el label en el repo si no está) y el post el tag `Needs info`.
Cuando un mensaje posterior trae lo que faltaba, el comentario del follow-up lo dice en su primera
línea, y con la última pieza se sacan el label y el tag. Nunca se cierra solo.

**Imágenes del reporte** (#39, `lib/assets.mjs`): el link de un adjunto de Discord muere a las 24 h,
así que al filar el issue (y al comentar un follow-up) cada imagen (`png/jpe?g/gif/webp`) se baja y se
sube a la rama huérfana `intake-assets` del repo del mod, en `<threadId>/<attachmentId>-<archivo>`, y el
body la enlaza por `/raw/intake-assets/…`: se ve para quien tiene acceso al repo privado y es un 404
para el resto. Cada commit lleva `[skip ci]`. La primera escritura crea la rama (blob, tree, commit sin
padre y ref) y las demás van por `PUT /contents`; un reintento encuentra el archivo ya subido (422) y lo
usa. Una subida fallida deja el link de Discord con un `::warning::` y nunca frena el issue. `DRY_RUN`
no sube nada; borrar un post `[TEST]` borra también su carpeta de la rama.

**La voz de Computah** (#17, `lib/voice.mjs`): todo lo que el bot escribe en un hilo — respuesta al
filar, pedido de datos, cierre, not planned, aviso de release, pregunta de la encuesta, pedido de tag —
sale de ahí, como **lista de variantes** por clave: IA primitiva, corta y seca, la etiqueta en negrita en
MAYÚSCULAS y el resto en frases recortadas. La variante rota con un contador por clave en
`state.voice` del proyecto (dos posts seguidos del mismo tipo nunca repiten texto; un dry run muestra la
que tocaría); el pedido de tag rota con el largo de `unrouted.json`. Cada variante conserva lo que hace
el mensaje (tabla en la cabecera del módulo). El bot reconoce sus mensajes por el texto: `OWN_REPLIES` y
`CLOSE_TEXTS` se arman con todas las variantes **y** con `LEGACY`, la redacción de antes, que sigue en
hilos abiertos. Un texto nuevo va al módulo, nunca suelto en otro archivo. El relay de `/reply` habla
el autor y queda fuera.

**`/reply`** (#11, `lib/replies.mjs`): los repos de mod son privados, así que el reporter **nunca ve
el issue** — el hilo es el único canal de vuelta. Un comentario del issue que **empieza con `/reply`**
se postea en el hilo, sin el prefijo, firmado `💬 **shiero:**` (`REPLY_NAME`) y con una mención al
dueño del hilo; en un post multi-mod lleva `**<tag>** · ` adelante. Sólo cuenta el de alguien con
escritura en el repo (`author_association` OWNER, MEMBER o COLLABORATOR), sobre un issue abierto o
cerrado hace ≤ `FOLLOWUP_DAYS_AFTER_CLOSE` días; lo demás del issue queda interno. Entregado, el
comentario recibe un 🚀. Una sola lectura por corrida (`/issues/comments?since=` de todo el repo,
`state.repliesSince`, que en la primera corrida se registra sin relayear nada), y `lastReply` por
hilo evita mandar uno dos veces. Más de 2000 caracteres se parte en varios mensajes. Sin loop: los
follow-ups que escribe el poller nunca empiezan con `/reply` y llevan `<!-- intake:from-discord -->`,
y el encabezado `💬` está entre las respuestas propias, así que no vuelve como follow-up. Una imagen
subida al issue no se ve en Discord: el link es del repo privado.

**Aviso de release** (#12, `lib/releases.mjs`): cuando sale el release que trae el fix, el bot lo
dice en el hilo del reporter. Un release cuenta como salido recién cuando **su card está en
`#announcements`** (#53): el GitHub Release es donde el publish arranca. La card se reconoce por el
encabezado de `announce.content` con esa versión. Sin card, el release espera a la corrida siguiente
sin gastar intentos; a las 6 h sigue esperando pero con un `::warning::`. Un publish fallido no avisa
nunca: lo destraba un `announce_only`.

**Card de release** (#54, `mod-released.yml`): un repo de mod nunca habla con Discord. Cuando las
tiendas aceptaron los jars (o en un `announce_only`), su `publish.yml` dispara un `repository_dispatch`
`mod-released` con `{project, version, tag}` y su secret `INTAKE_DISPATCH_TOKEN` (PAT fine-grained
sólo sobre intake-bots, Contents: read and write). intake-bots no le cree al payload: el proyecto tiene
que estar en `projects.json`, el tag tiene que ser un release publicado de `<PREFIX>_GH_REPO` y nombrar
esa versión, y el CHANGELOG se lee en ese tag con `GH_TOKEN`. El workflow no escribe `state.json` ni
entra al grupo `intake`, donde un dispatch pendiente puede quedar reemplazado y perder su card. Cerrar
los issues del release sigue en el `publish.yml` del mod: eso es GitHub, no Discord.

**Encuesta de satisfacción** (#13, `lib/survey.mjs`): el aviso `🚀 … vX.Y.Z` de un Bug o
Crash (#12) lleva en **el mismo mensaje** un poll nativo de Discord — *FIX CHECK: did vX.Y.Z solve your problem?*,
Yes / Partly / No, 168 h —, así que sale y se reintenta junto con el aviso. Sólo cuenta el voto del
**dueño del hilo**, guardado en `entry.survey.owner` al postear: cada corrida lee el mensaje (los
conteos) y los votantes sólo de las respuestas con votos, y el primer voto del reporter es el
resultado. **Yes** se registra. **Partly / No** además le pone `fix-failed` al issue (el bot crea el
label), comenta el voto y pregunta en el hilo qué sigue pasando, con mención; **no reabre**. La
ventana de follow-ups vuelve a contar desde ese voto, así que la respuesta llega al issue aunque el
release haya salido semanas después del cierre. Sin voto en 168 h: `no-answer`. Cada resultado es una
fila de `satisfaction.json`. Mientras el poll está abierto, y después de un Partly / No, el hilo no se
archiva; tras Yes o `no-answer` se archiva como cualquier otro. Una corrida sin voto nuevo no toca el
state. Necesita **Send Polls** en `#tickets` (en el overwrite del bot, `server.json`).

**Métricas** (#14, `lib/metrics.mjs`): cada fila termina con una tabla en su job summary —
ingest lag (el `created_at` del issue menos la hora del post, sacada del snowflake), primera respuesta
humana, tiempo a cerrar (mediana · p90 · máximo, histórico y últimos 30 días), issues `discord`
abiertos con la edad del más viejo, `needs-info` y la encuesta. Sale del listado de issues `discord`
que la fila ya lee para el backfill (un `GET` por corrida cuando el backfill no lo pidió) y de
`satisfaction.json`; no escribe state. La primera respuesta es el primer comment de un escritor sin
`FROM_DISCORD` — un `/reply` o no —: `relayReplies` la anota una vez en `entry.firstReplyAt`, sólo en
issues filados desde que existe (`entry.awaitingReply`), porque antes de #11 los follow-ups del poller
no llevaban marca. Un listado que falla deja "Unavailable" en el summary y **no** pone roja la fila.

**Votos** (#32): el voto es la reacción default de los foros, 👍 (`default_reaction_emoji` en
`server.json`), así que el botón bajo el post en la lista del foro es la boleta. Cada corrida lee el
starter de cada Idea con el issue abierto, archivado o no (un `GET` por idea: el listado de hilos no
trae reacciones), y le deja al issue el bucket más alto que alcanza: `votes:5+` o `votes:10+`, uno a
la vez (el bot crea el label si no está). Con menos de 5 lo saca. Un issue cerrado conserva el que
tenía. Cuenta todo 👍, incluido el del autor del post. Los posts `[TEST]` del bot también cuentan, y
el fijado nunca entra a `tracked`.

**Triage en Linear** (#9, `lib/linear.mjs`): cada issue filado espeja a Linear en `Triage`, sin
project ni prioridad. La fila lo planifica: el project es el `linear` de su objeto en `projects.json`,
buscado por nombre, y la prioridad sale del tipo (Crash → 1 Urgent, Bug → 2 High, Idea y Feedback →
4 Low, sin tag de tipo → *No priority*, que decide un humano). El estado pasa a `Backlog`. **Sólo se
llena lo vacío**: un project, una prioridad o un estado que alguien ya tocó se respetan, y nunca se
crea nada en Linear (el sync es bidireccional: un issue creado ahí abre otro en GitHub). El espejo se
busca **por la URL del issue de GitHub** en los attachments del COB (`attachmentsForURL`), nunca por
título, con un solo request por issue. La entrada lleva `linearSince` hasta que queda planificado: el
paso corre al final de la corrida, para darle tiempo a que el espejo llegue, y una corrida sin
pendientes no llama a Linear ni escribe state. Si a la hora no hay espejo, la entrada queda
`linear: "no mirror"` y la fila sale roja una vez: el repo no está en la lista de GitHub Issues de la
integración. Una fila sin `linear` (mid-battle-exp, que no espeja) no hace nada. Sin
`LINEAR_API_KEY`, warning y los pendientes esperan a que se cargue; una key rechazada corta en la
primera llamada.

**Aviso de crash**: al filar un Crash, el bot postea en `#moderator-only` (por nombre, de
`server.json`) con mención al rol `Author`, el hilo y el `owner/repo#N`. Una prioridad Urgent en
Linear no le avisa a nadie que no esté mirando el board. Sale una vez, al filar; si falla, la fila
sale roja.

**Bug Catcher** (#31): quien entra al tally de `reporters.json` recibe el rol `Bug Catcher` (hoisted,
declarado en `server.json` bajo `Computah`), con las mismas exclusiones que los créditos: ni bots —
los posts `[TEST]` son del bot — ni `AUTHOR_USERNAMES`. La entrada guarda el `id` del autor al
filar, y la corrida le pone el rol a cada entrada con `id` y sin `bugCatcher`. El resultado queda
anotado una vez: `true` (no se repone si alguien lo saca) o `"not a member"` si ya no está en el
server; cualquier otra falla es un `::warning::` y se reintenta. Una entrada sin `id` no lo recibe:
son reporteros de los bots viejos que no aparecen en ningún hilo ni como miembro.

### El foro único

`#tickets` (`TICKETS_FORUM_ID`) recibe los posts de todos los mods: cada post lleva un **tag de tipo**
y un **tag de mod**. Cada fila lee ese foro además del suyo viejo y se queda sólo con los posts que
llevan su `tag`. Los tags de mod nunca deciden el tipo: `classify` no los ve.

- **Un post con dos mods** se vuelve un issue en cada repo, y cada body nombra a los otros. Responde
  al filar sólo el primero en el orden de `projects.json`; cada mensaje posterior (cierre, release)
  lleva el nombre del mod adelante.
- **Un post sin tag de mod** no es de ninguna fila. El job `unrouted` le pide el tag una vez y lo anota
  en `unrouted.json`; cuando el tag aparece, la fila dueña lo fila en su corrida siguiente. *Require
  tag* no lo evita: exige *algún* tag, y uno de tipo alcanza.
- Los foros viejos se siguen leyendo: los cierres de sus hilos se siguen anunciando ahí.
- **Tags de estado**: `Resolved`, `Not planned` y `Needs info`, moderados (sólo los pone quien tiene
  *Manage Threads*: el bot y el staff). Al archivar un post cerrado, el bot le suma `Resolved` o
  `Not planned` según el `state_reason` del issue, sin sacarle los tags del reporter; si ya tiene 5,
  el máximo de Discord, se archiva sin estado. Un post con dos mods recibe el estado recién cuando
  cerró el último, leído de los mensajes de cierre del hilo; con un fix entre ellos es `Resolved`.
  `Needs info` lo pone el filado de un reporte incompleto y lo saca la última pieza que llega (ver
  arriba); un cierre lo reemplaza. Los tags de estado nunca deciden el tipo.
- Discord permite 20 tags por foro: 4 de tipo y 3 de estado dejan lugar a 13 mods.

## projects.json

| Campo | |
|---|---|
| `dir` | Carpeta del proyecto: ahí corre el poller y ahí viven su `state.json` y su `reporters.json` |
| `name` | Nombre de la fila en Actions |
| `prefix` | Prefijo de sus secrets y variables (`DITTO`, no `DITTO_HMS`) |
| `tag` | Su tag de mod en el foro único. Tiene que existir con ese nombre en `server.json`; si falta en el foro, la fila sale roja |
| `ua` | `User-Agent` hacia Discord y GitHub |
| `skipBeforeId` | Opcional. Snowflake de corte (ver abajo) |
| `linear` | Opcional. El **nombre** del project de Linear de sus espejos (`Routes`, `Cobblemon Champions`…: no siempre el del mod). Sin él, la fila no triagea; va vacío en un repo que no espeja |
| `gate` | Opcional. `enabled-var` (ver abajo) |
| `intake` | Opcional. `false` en un mod que sólo anuncia releases: no entra al poller, al catálogo de `#mods`, al healthcheck ni al bootstrap, y sólo necesita `dir`, `name`, `prefix`, `announce` y la variable `<PREFIX>_GH_REPO` |
| `announce` | El anuncio de release: `content` (la línea de encabezado, sin links; `{version}` se reemplaza), `color` y `footer` del embed, y `links` (`modrinth`, `curseforge`, `wiki`, `sponsor`), que salen como botones (una tienda que falta no lleva botón). `sponsor` va pelado: el botón le suma `metadata_mod=<dir>` y `metadata_src=discord-announce` (o `discord-catalog` en la card de `#mods`), que el export de GitHub Sponsors muestra en su columna `metadata`. El changelog no tiene botón: ya va en el embed. El título del embed apunta a Modrinth `/changelog`, o CurseForge `/files/all` **sólo si el link tiene la forma `/minecraft/mc-mods/<slug>`** (`/projects/<id>` no redirige subpáginas). **El canal no va acá**: todo mod postea en `#announcements` de `server.json` (su id fijado) y menciona el rol que se llama como su `tag`, buscado por nombre; `allowed_mentions` nombra sólo ese rol. Sin rol, la card sale sin ping y con un `::warning::` |

**Dar de alta un proyecto:**

```bash
node lib/bootstrap.mjs --dir <dir> --tag "<Tag>" --emoji <emoji> [--name "<Name>"] [--prefix <PREFIX>]   # dry run
node lib/bootstrap.mjs --dir <dir> --tag "<Tag>" --emoji <emoji> --write
```

Agrega a `server.json` el tag del mod en `#tickets`, un rol con su nombre (sin permisos, arriba de
`@everyone`: el ping opt-in de su anuncio) y esa opción en el prompt de onboarding *Which mods do you
want release pings for?*, y crea `<dir>/state.json` vacío. Sólo agrega lo que falta: una segunda
corrida dice `nothing to do`. No toca Discord ni escribe ids ni variables: al final imprime el objeto
para `projects.json`, los secrets, la fila del registro y el `server.yml` que aplica el cambio. El
objeto va a `projects.json` **después** de cargar los secrets: antes es una fila roja en cada corrida.
Para un mod que ya está en `projects.json`, `--dir` alcanza. No
hace falta un workflow nuevo.

### Gates

| Gate | Corre cuando | Quién lo usa |
|---|---|---|
| `enabled-var` | `<PREFIX>_INTAKE_ENABLED == 'true'`, o siempre en un `workflow_dispatch` manual (el del pacer no cuenta) | nuzlocke |

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
| `DISCORD_TOKEN` | secret | **Compartido**: el bot único, para cada fila del intake, `server.yml`, `catalog.yml`, `mod-released.yml` y el job `unrouted` |
| `TICKETS_FORUM_ID` | variable | **Compartida**: el foro único de tickets |
| `GH_TOKEN` | secret | **Compartido**: el PAT con el que cada fila abre issues en el repo de su mod, `catalog.yml` lee el `DESCRIPTION_SHORT.txt` y `mod-released.yml` valida el release y lee el CHANGELOG |
| `<PREFIX>_GH_REPO` | variable | `owner/repo` destino |
| `LINEAR_API_KEY` | secret | **Compartido**: key personal de Linear (`intake-bots`, Write, team COB) con la que las filas triagean los espejos y `health.mjs` el de "Intake unhealthy" |

`DISCORD_GUILD_ID` no es opcional en la práctica: sin él, `/guilds/{id}/threads/active` no se llama y
el bot **sólo ve threads archivados**, así que un reporte recién abierto no entra hasta que Discord lo
archive.

Los secrets se cargan con `cargar-secrets.ps1` desde la raíz del workspace (`-Auditar` dice qué falta
sin escribir nada). La lista autoritativa está en `Reference/Required Secrets and Variables` del vault.

## Canales

Server: https://discord.gg/SwcwXcCN4k

Cada mod vive sólo en los dos canales globales: `#tickets` (`1560781769752445028`, foro único, un
tag por mod) y `#announcements` (`1560858633049215047`, tipo Announcement, ping al rol del mod).

### El catálogo

`#mods` (`1560884963967246506`, sólo lectura) tiene una card por proyecto de `projects.json`, en
ese orden: la n-ésima card es el n-ésimo post más viejo del bot en el canal. `catalog.yml` la edita
en el lugar cada hora, sólo cuando cambia lo que muestra:

- **Pitch**: el `DESCRIPTION_SHORT.txt` del repo del mod, nunca el resumen de la tienda (que puede
  estar viejo).
- **Status, versión, Minecraft, loaders y descargas**: Modrinth, y CurseForge vía
  [cfwidget](https://api.cfwidget.com), porque la Core API de CurseForge pide una key que el
  `CURSEFORGE_TOKEN` no es. Las descargas van compactas (`21.1K`), así una descarga suelta no edita
  la card.
- **Modrinth da 404** (en revisión o en draft): la card dice `Released` + `Modrinth: in review` si
  CurseForge lo tiene, y no lleva botón de Modrinth hasta que Modrinth lo apruebe. Eso pasa solo, en
  la corrida siguiente.
- Un error que no es una respuesta (un 5xx, cfwidget todavía buscando el proyecto) deja esa card como
  estaba y la corrida sale en rojo.
- **Descargas en el tiempo**: la misma corrida guarda los totales en `stats/downloads.json` de la
  rama orphan `stats` (nunca en `main`), una fila `{ at, mod, modrinth, curseforge }` por mod cuyo
  número se movió desde su última fila. `mod` es el `dir`, y una tienda donde el mod no está va en
  `null`. Un mod que esta corrida no pudo bajar no lleva fila. La rama se crea sola la primera vez:
  `git show origin/stats:stats/downloads.json`.

Un mod nuevo en `projects.json` agrega su card al final. Reordenar `projects.json` reescribe las
cards, no las mueve. `server.json` declara `#mods` **sin** `messages`, para que `server.mjs` no
toque las cards.

## El server como código

[`server.json`](server.json) declara el server de Discord entero, y `server.yml` hace que el guild
coincida. Cada cambio de layout es un commit revisado, no un click que nadie recuerda.

```bash
gh workflow run server.yml --repo manucruzleiva/intake-bots                      # dry run: el diff en el job summary
gh workflow run server.yml --repo manucruzleiva/intake-bots -f dry_run=false     # aplicar
```

- **Lo declarado se gestiona; lo que falta, no.** Un canal sin `topic` conserva el que tiene, y
  `"welcome_screen": null` no se toca nunca. Los campos llevan el nombre de la API de Discord.
- **Todo se referencia por nombre** (roles en los overwrites, canales en `guild`, AutoMod y
  onboarding), así que un archivo puede nombrar un canal que la misma corrida crea. El `id` es
  opcional y sólo fija el match: primero por id, después por nombre, y si no hay ninguno se crea.
- **El orden del archivo es el orden del server**: roles de arriba abajo, canales de arriba abajo
  dentro de su categoría. Los permisos van por nombre (`SendMessages`); un bit sin nombre, `bit47`.
- **Un canal de texto puede declarar `messages`**: los posts del bot en él, del más viejo al más
  nuevo, con `content` y `embeds` de la API. El n-ésimo declarado es el n-ésimo post del bot: se
  edita en el lugar si difiere, se postea si falta, y uno de más es `? extra`. Los mensajes de
  humanos no se tocan, y sólo se leen los canales que declaran la clave (los anuncios de release
  del mismo bot quedan afuera). Mira los últimos 100 mensajes: es para canales sin escritura, como
  `#rules`.
- **Un foro puede declarar `pinned`** (`{ title, tags, messages }`, #38): el post del bot ahí, fijado
  y bloqueado. El primer mensaje es el starter y el resto son mensajes del bot en el hilo, con la misma
  regla que `messages`. Se encuentra por el flag de fijado o por el título. Los `tags` van por nombre
  y en el orden del foro, y en un foro con *require tag* son obligatorios también para el bot (40067).
  `#tickets` lo usa para el ejemplo de cómo reportar: los cuatro tags de tipo, un starter que explica
  la información crucial y una plantilla por tipo. El poller y `unrouted` saltean los hilos fijados.
- **`emojis` declara los emojis de aplicación del bot** (`{ name, file }`, con `file` relativo a la
  raíz): son de la app, sirven en cualquier server y no gastan slot del guild. El que falta se sube, y
  el que existe se reconoce por nombre y nunca se vuelve a subir, porque Discord no deja comparar la
  imagen: para cambiar un logo, se renombra o se borra el viejo a mano. Los botones de Modrinth y
  CurseForge (`app` en `BUTTON_ROWS` de `lib/announce.mjs`) muestran el emoji de ese nombre, y `⬇️`
  con un `::warning::` mientras la app no lo tenga.
- **Un cambio de categoría va de a un canal**: Discord rechaza un PATCH de posiciones que mueve más de
  uno (40009), así que cada `→ move` es su propia llamada y el PATCH masivo sólo ordena.
- **Nada se borra sin `prune`.** Lo que sobra sale en el diff como `? extra` y se deja, para que un
  typo no cueste un canal. Con `prune`, borrar un foro borra todos sus threads: leé el dry run antes.
- **Un rol por encima del de `Computah` no se puede editar**: Discord rechaza el cambio aunque el
  bot sea Administrator, y el diff lo avisa con `!`. Se arrastra `Computah` arriba a mano.
- **Adoptar un cambio hecho a mano:** `node lib/server.mjs --export --file server.json` vuelca el
  guild vivo con la misma forma, y el diff de git muestra qué cambió.

Signos del diff: `+` crear, `~` cambiar, `→` mover de categoría, `↕` reordenar, `?` sobra y se
deja, `-` borrar (sólo con `prune`), `!` aviso. Una segunda corrida sobre un guild ya reconciliado
dice `nothing to do`.

## El workflow

- `plan` lee `projects.json` y los gates; `poll` corre una fila por proyecto con `fail-fast: false`,
  así que un proyecto roto no cancela a los demás.
- Cada fila commitea sólo su `state.json`/`reporters.json` con `[skip ci]`. Como todas pushean al
  mismo branch en el mismo segundo, el push reintenta sobre un `git pull --rebase` hasta cinco veces:
  un state que no llega al repo es un lote de issues duplicados en la corrida siguiente.
- `concurrency: intake` serializa corridas enteras: un dispatch manual espera a la corrida en curso.
- El checkout del poll es la punta de la rama (`ref: ${{ github.ref }}`), no `github.sha`: una
  corrida que esperó en la cola lleva el SHA de antes del push de la anterior y, con ese
  `state.json`, volvería a filar los mismos hilos.

### La cadencia

El `schedule` de un repo público lo encola GitHub según su carga: el `*/10` llegaba con horas de
separación (mediana 276 min el 2026-10-16). La cadencia la pone una cadena de dispatches, que sí
arrancan en segundos:

1. Al terminar, el job `next` de `intake.yml` deja un `intake-pacer.yml` en espera, salvo que ya
   haya uno esperando. Corre con `if: always()`: una fila rota no corta la cadena.
2. El pacer espera en el environment `intake-pacing`, con un **wait timer de 10 minutos**: la espera
   no ocupa runner. Después dispara `intake.yml` con `trigger=scheduler`.
3. Los dos dispatch usan el `GITHUB_TOKEN` (con él, `workflow_dispatch` sí crea una corrida nueva) y
   reintentan cinco veces.

Si la cadena se corta igual, la próxima corrida que llegue por `schedule` o por un dispatch manual
la revive sola. El environment se crea una vez:

```bash
gh api -X PUT repos/manucruzleiva/intake-bots/environments/intake-pacing -F wait_timer=10
```

Sin él, GitHub lo crea al primer job **sin** wait timer y la cadena gira sin pausa.

## El healthcheck

La falla que importa no es una corrida roja sino una **verde que no importa nada**. Por eso el poller
sale con exit 1 también cuando terminó sin hacer parte de su trabajo (no pudo listar el foro, no pudo
filar un hilo, GitHub le rechazó una lectura), y `lib/health.mjs` lee esas filas:

| Chequeo | Problema cuando |
|---|---|
| Cadena | la última corrida de `intake.yml` tiene más de 30 min |
| Proyecto | sus últimas 2 filas ejecutadas fallaron (una sola es un blip y sale en amarillo) |
| Sin vigilar | su gate lo tiene apagado: se lista, pero no es un problema |

Corre en dos lados: como job `health` al final de cada intake (cada ~10 min) y desde
`healthcheck.yml` por `schedule`, que es el único que ve que la cadena se cortó. El aviso es **un
issue, "Intake unhealthy"**, que abre el bot: las corridas del pacer las dispara el `GITHUB_TOKEN` y
GitHub no le avisa a nadie cuando fallan. Mientras los problemas sigan iguales sólo se edita (sin
notificar), cuando cambian se comenta, y se cierra solo cuando todo vuelve a estar sano. Su espejo de
Linear recibe project `Intake Bots`, prioridad 2 High y `Backlog` (`lib/linear.mjs`, con
`LINEAR_API_KEY`): se busca mientras el issue tiene menos de una hora, así que no hace falta state y
un incidente cuesta unas pocas lecturas. Una falla de Linear es un warning, no un chequeo rojo.

### La página de estado

https://manucruzleiva.github.io/intake-bots/ muestra el mismo veredicto sin abrir Actions. La
publican los dos lados del healthcheck (job `pages` de `intake.yml` y de `healthcheck.yml`):
`health.mjs` escribe `status.json` en `_site/` cuando tiene `HEALTH_PAGE_DIR`, al lado de
[`lib/status-page.html`](lib/status-page.html), y `actions/deploy-pages` lo sube. No se commitea nada.

La página sólo se re-publica desde una corrida viva, así que **decide sola si sus datos están
viejos**: compara el `generated_at` de `status.json` con el reloj de quien la mira, y pasados 30 min
muestra "Stale — the intake chain may be down" en lugar del último veredicto. Re-lee el JSON cada
minuto. No guarda historial: un deploy estático no tiene dónde.

**Open tickets** (`lib/backlog.mjs`): debajo del veredicto, una fila por proyecto de `projects.json`
con su ícono y cuántos issues abiertos tiene su repo, contados por **tipo**, **estado**, **prioridad**
u **origen** (un selector) y ordenables por cualquier columna; la elección queda en el `localStorage`
de quien mira. Sólo conteos, nunca títulos: la página es pública y los repos de mod no. `health.mjs`
lo escribe como `backlog.json` con el secret `GH_TOKEN` (env `MODS_GH_TOKEN`: el `GH_TOKEN` del job es
el de este repo y no ve los otros) y `LINEAR_API_KEY`.

- **Tipo**: labels del issue (`crash`, `bug`, `documentation`, `enhancement`) o `RESEARCH` en el
  título; sin nada de eso, la prioridad del espejo de Linear, que se pone por tipo (1 Crash, 2 Bug,
  3 Improvement, 4 Feature). Sin espejo ni label, `Untriaged`.
- **Estado**: el state del espejo, buscado por la URL del issue en sus attachments. `needs-info` o
  `blocked` le ganan. Sin espejo abierto (mid-battle-exp no espeja), `Not in Linear`.
- **Ícono**: el `icon_url` de Modrinth, el thumbnail de CurseForge si Modrinth todavía no lo aprobó, y
  si no el emoji del tag en `#tickets`.

Nada de esto pone rojo el chequeo: una fuente que no se pudo leer queda como línea bajo la tabla.

Pages se habilitó una vez, en modo workflow:

```bash
gh api -X POST repos/manucruzleiva/intake-bots/pages -f build_type=workflow
```

`healthcheck.yml` además re-habilita `intake.yml` y a sí mismo en cada corrida, para que el apagado
de los `schedule` tras 60 días sin actividad no los alcance.

Para probarlo sin tocar un secret, `intake.yml` tiene el input `break`: `<dir>:discord`,
`<dir>:github` o `<dir>:forum` rompen esa fila sola en esa corrida.

```bash
gh workflow run intake.yml --repo manucruzleiva/intake-bots -f break=raid-icons:forum
```

## Probar a mano

```bash
gh workflow run intake.yml --repo manucruzleiva/intake-bots
```

Arranca también la cadena del pacer, si estaba cortada. El log de cada fila termina en
`Done. N new issue(s) filed; F follow-up comment(s); R /reply relay(s); S survey result(s); M close(s) announced; K threads tracked.`
(`R` y `S` sólo aparecen cuando hubo alguno.)
