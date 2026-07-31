# Cobblemon Nuzlocke & Soul Link — intake (pendiente)

Nombre de display **Cobblemon Nuzlocke & Soul Link**; identificadores técnicos cortos
(`cobblemon-nuzlocke`, mod id `cobblemon_nuzlocke`) — de ahí el nombre de esta carpeta.

Todavía no hay bot acá, **a propósito**: el mod `cobblemon-nuzlocke` aún no existe como repo. Sale
del split de Routes descrito en
[#122](https://github.com/manucruzleiva/routes/issues/122), y hasta que ese repo exista no hay dónde
abrir los issues.

No hay workflow en `.github/workflows/` para este proyecto por el mismo motivo: un cron apuntando a
un repo inexistente fallaría cada 5 minutos y llenaría el historial de Actions de rojo.

## Cuando el repo exista

1. Copiar `../routes/poll.mjs` acá — es el poller más completo de los tres (inlinea imágenes y pliega
   crash reports `.txt`/`.log`/`.json` en un `<details>` antes de que expire el link del CDN de
   Discord), y Nuzlocke va a recibir sobre todo reportes de bugs con logs.
2. Crear `.github/workflows/intake-nuzlocke.yml` copiando `intake-routes.yml` y cambiando el prefijo
   de secrets `ROUTES_` → `NUZLOCKE_` y el `working-directory` a `nuzlocke`.
3. Cargar los secrets `NUZLOCKE_*` y la variable `NUZLOCKE_GH_REPO`.
4. Crear los canales foro de Discord para el mod nuevo.

## Decisión de alcance pendiente

Si Nuzlocke y Routes comparten los mismos canales de Discord (probable al principio, ya que hoy son
un solo mod y una sola comunidad), conviene **no** duplicar el poller: que el de Routes triage por
tag del foro y abra el issue en uno u otro repo. Dos bots sobre el mismo canal se pisan y duplican
issues, porque cada uno lleva su propio `state.json`.
