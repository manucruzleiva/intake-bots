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
| [`lib/unrouted.mjs`](lib/unrouted.mjs) | Los posts del foro único sin tag de mod: les pide el tag una vez y no fila nada |
| [`lib/matrix.mjs`](lib/matrix.mjs) | Arma la matrix del workflow desde `projects.json` |
| [`lib/gates.mjs`](lib/gates.mjs) | Los gates: qué proyecto corre y por qué. Lo usan `matrix.mjs` y `health.mjs` |
| [`lib/health.mjs`](lib/health.mjs) | El healthcheck: lee las corridas de `intake.yml` y abre/cierra el issue "Intake unhealthy" |
| [`lib/announce.mjs`](lib/announce.mjs) | El anuncio de un release en Discord. Lo corre `announce.yml`; `--print` muestra el payload sin postear |
| [`lib/status-page.html`](lib/status-page.html) | La página de estado en GitHub Pages; lee el `status.json` que escribe `health.mjs` |
| [`lib/server.mjs`](lib/server.mjs) | El reconciliador del server de Discord contra `server.json`. Dry run por defecto; `--export` vuelca el guild vivo |
| [`server.json`](server.json) | **El server de Discord entero**: roles, categorías, canales, overwrites, tags de foro, mensajes fijos del bot (`#rules`), AutoMod, welcome screen y onboarding |
| [`projects.json`](projects.json) | Un objeto por proyecto: lo único que hay que tocar para dar uno de alta |
| [`.github/workflows/intake.yml`](.github/workflows/intake.yml) | El único workflow de intake |
| [`.github/workflows/intake-pacer.yml`](.github/workflows/intake-pacer.yml) | Le pone cadencia: espera 10 min y vuelve a disparar `intake.yml` |
| [`.github/workflows/healthcheck.yml`](.github/workflows/healthcheck.yml) | El healthcheck desde afuera de la cadena, por `schedule`: ve si la cadena se cortó |
| [`.github/workflows/server.yml`](.github/workflows/server.yml) | A mano: hace que el guild coincida con `server.json` (`dry_run` por defecto, `prune` apagado) |
| [`.github/workflows/announce.yml`](.github/workflows/announce.yml) | Reutilizable (`workflow_call`): el job `announce` del `publish.yml` de cada mod lo llama para anunciar el release |
| `unrouted.json` | Los posts del foro único a los que ya se les pidió el tag de mod |
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
- Discord permite 20 tags por foro: 4 de tipo dejan lugar a 16 mods.

## projects.json

| Campo | |
|---|---|
| `dir` | Carpeta del proyecto: ahí corre el poller y ahí viven su `state.json` y su `reporters.json` |
| `name` | Nombre de la fila en Actions |
| `prefix` | Prefijo de sus secrets y variables (`DITTO`, no `DITTO_HMS`) |
| `tag` | Su tag de mod en el foro único. Tiene que existir con ese nombre en `server.json`; si falta en el foro, la fila sale roja |
| `ua` | `User-Agent` hacia Discord y GitHub |
| `skipBeforeId` | Opcional. Snowflake de corte (ver abajo) |
| `gate` | Opcional. `enabled-var` o `channel-set` (ver abajo) |
| `announce` | El anuncio de release: `content` (la línea de encabezado, sin links; `{version}` se reemplaza), `color` y `footer` del embed, y `links` (`modrinth`, `curseforge`, `wiki`, `sponsor`), que salen como botones (una tienda que falta no lleva botón). El changelog no tiene botón: ya va en el embed. El título del embed apunta a Modrinth `/changelog`, o CurseForge `/files/all` **sólo si el link tiene la forma `/minecraft/mc-mods/<slug>`** (`/projects/<id>` no redirige subpáginas). **El canal no va acá**: todo mod postea en `#announcements` de `server.json` (su id fijado) y menciona el rol que se llama como su `tag`, buscado por nombre; `allowed_mentions` nombra sólo ese rol. Sin rol, la card sale sin ping y con un `::warning::` |

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
Un mod nuevo no tiene foro propio: sin `<PREFIX>_TICKETS_CHANNEL_ID`, el poller lee sólo `#tickets`.
Para un mod que ya está en `projects.json`, `--dir` alcanza. No
hace falta un workflow nuevo.

### Gates

| Gate | Corre cuando | Quién lo usa |
|---|---|---|
| `enabled-var` | `<PREFIX>_INTAKE_ENABLED == 'true'`, o siempre en un `workflow_dispatch` manual (el del pacer no cuenta) | nuzlocke |
| `channel-set` | `<PREFIX>_TICKETS_CHANNEL_ID` tiene valor | raid-icons, mid-battle-exp, champions-training |

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
| `DISCORD_TOKEN` | secret | El bot único, para `server.yml` y el job `unrouted` |
| `TICKETS_FORUM_ID` | variable | **Compartida**: el foro único de tickets |
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

Todo mod nuevo vive sólo en los dos canales globales: `#tickets` (`1560781769752445028`, foro único,
un tag por mod) y `#announcements` (`1560858633049215047`, tipo Announcement, ping al rol del mod).
Los de la tabla son los canales viejos de cada mod: el poller sigue leyendo los foros, y los de
anuncios ya no reciben cards.

| Proyecto | Prefijo | Tickets (viejo) | Anuncios (viejo) |
|---|---|---|---|
| routes | `ROUTES` | `1519377359290110137` | `1522425693265203331` |
| picnic | `PICNIC` | `1532081390508839083` | `1532081457462513734` |
| ditto-hms | `DITTO` | `1532081100749406218` | `1532081291963531574` |
| nuzlocke | `NUZLOCKE` | `1532081527662313764` | `1532081610034253904` |
| raid-icons | `RAID_ICONS` | `1545050296240046090` | `1545050328435662858` |
| mid-battle-exp | `MID_BATTLE_EXP` | `1560084088239554711` | `1560084267969679471` |
| champions-training | `CHAMPIONS` | `1544709874661851296` | `1545050120280604703` |

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
notificar), cuando cambian se comenta, y se cierra solo cuando todo vuelve a estar sano.

### La página de estado

https://manucruzleiva.github.io/intake-bots/ muestra el mismo veredicto sin abrir Actions. La
publican los dos lados del healthcheck (job `pages` de `intake.yml` y de `healthcheck.yml`):
`health.mjs` escribe `status.json` en `_site/` cuando tiene `HEALTH_PAGE_DIR`, al lado de
[`lib/status-page.html`](lib/status-page.html), y `actions/deploy-pages` lo sube. No se commitea nada.

La página sólo se re-publica desde una corrida viva, así que **decide sola si sus datos están
viejos**: compara el `generated_at` de `status.json` con el reloj de quien la mira, y pasados 30 min
muestra "Stale — the intake chain may be down" en lugar del último veredicto. Re-lee el JSON cada
minuto. No guarda historial: un deploy estático no tiene dónde.

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
`Done. N new issue(s) filed; F follow-up comment(s); M close(s) announced; K threads tracked.`
