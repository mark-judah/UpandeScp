# Crop icons

Cut from `../icons.png` (a 2×2 sheet) by `../extract_icons.py`. Re-run that script
after replacing the sheet; nothing here is hand-edited.

Each crop ships three tints, at 512px and 96px:

| file | use |
|---|---|
| `<crop>-accent.png` | on paper — the default |
| `<crop>-light.png`  | on ink or on an accent-filled chip |
| `<crop>-ink.png`    | on gold, or anywhere accent would fight the surface |

Accents:

| crop | accent |
|---|---|
| rose | `#a33a5b` |
| avocado | `#5f7d33` |
| coffee | `#6f4a2f` |
| vegetables | `#b4531f` |

The sheet draws each tile differently — coffee is a grey glyph on pure black,
rose and avocado are light on near-black, vegetables is dark on white — so the
extractor reads the background from each tile's own frame and cuts with Otsu
rather than a fixed threshold.
