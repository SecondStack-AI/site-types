# Vendored files

| Files | Source | Version | License |
|---|---|---|---|
| `fonts/inter-*-standard-*.woff2` (Inter, `wght` and `opsz` axes) | npm `@fontsource-variable/inter` | 5.3.0 | SIL OFL 1.1, `fonts/LICENSE-inter.txt` |
| `fonts/jetbrains-mono-*-wght-normal.woff2` | npm `@fontsource-variable/jetbrains-mono` | 5.3.0 | SIL OFL 1.1, `fonts/LICENSE-jetbrains-mono.txt` |
| `vendor/purify.es.js` (byte-identical copy of `dist/purify.es.mjs`, renamed so every host serves it as JavaScript) | npm `dompurify` | 3.4.17 | Apache-2.0 or MPL-2.0, `vendor/LICENSE-dompurify.txt` and `vendor/LICENSE-dompurify-mpl.txt` |
| `vendor/pptxgen.bundle.js` (byte-identical copy of `dist/pptxgen.bundle.js`; loaded only for a PowerPoint export) | npm `pptxgenjs` | 4.0.1 | MIT, `vendor/LICENSE-pptxgenjs.txt` |
| JSZip, bundled inside `vendor/pptxgen.bundle.js` | npm `jszip` | 3.10.1 | MIT or GPL-3.0 (used under MIT), `vendor/LICENSE-jszip.txt` |

Font subsets: latin, latin-ext and cyrillic. The viewer has no other dependencies.
