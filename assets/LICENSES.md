# Asset licenses

Every third-party asset used in the build is listed here. Credits must also appear in the in-game credits screen.

| Files | Source | Author | License | Changes |
|---|---|---|---|---|
| `public/assets/sprites/knight_*.png`, `ranger_*.png`, `mage_*.png` | [KayKit Character Pack: Adventurers 1.0](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0) | Kay Lousberg (www.kaylousberg.com) | CC0 | Rendered to isometric sprite sheets with tools/sprite-baker |
| `public/assets/sprites/skeleton_*.png` | [KayKit Character Pack: Skeletons 1.0](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0) | Kay Lousberg (www.kaylousberg.com) | CC0 | Rendered to isometric sprite sheets with tools/sprite-baker |
| `public/assets/test/floor.png` | [Flare: Empyrean Campaign](https://github.com/flareteam/flare-game) (`mods/fantasycore/images/tilesets/tileset_dungeon.png`, tiles 16–47) | Flare team | CC-BY-SA 3.0 | Cropped floor tiles into an atlas; derivative is CC-BY-SA 3.0 |

Source models are not stored in the repo: `npm run bake:fetch` downloads them into `art_src/`, `npm run bake` opens the baker.

## Fonts (bundled via @fontsource, SIL Open Font License 1.1)

| Font | Authors | License |
|---|---|---|
| Cormorant SC | The Cormorant Project Authors | OFL 1.1 |
| PT Sans | ParaType Inc. | OFL 1.1 |
