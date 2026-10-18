# art

## emoji/

The bot's application emojis, declared in `server.json` under `emojis` and uploaded by `lib/server.mjs`.
128×128 PNG, transparent, the logo centered on a square canvas. Discord matches an emoji by name only: a
new image under the same name is never uploaded, so rename it or delete the old one by hand.

| File | Source | Color |
|---|---|---|
| `modrinth.png` | `packages/assets/branding/logo.svg` in [modrinth/code](https://github.com/modrinth/code) | `#1BD96A` |
| `curseforge.png` | the `logo` symbol of `https://docs.curseforge.com/img/sprite.svg` | `#F16436` |

Both sources draw in `currentColor`; the PNG fills it with the store's brand color, so the logo reads on
Discord's dark and light themes. The shapes are the stores' own, unedited.
