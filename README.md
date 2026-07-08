# Capture One Match Look Pipeline

A macOS automation script that transfers the in-camera creative look from a Sony RAW+JPEG pair onto the denoised DNG produced by DxO PureRAW, using Capture One's Match Look feature.

The workflow it automates: you shoot RAW+JPEG (the JPEG carries a creative look / picture profile), develop the RAW to a clean DNG in PureRAW, and then want that look back on the DNG. This script pairs each DNG with its originating creative-look JPEG and drives Capture One's Match Look to copy the look across, then writes a pairing manifest.

## Requirements

- macOS only (the script is JXA / AppleScript-driven and controls Capture One through Apple Events and UI scripting).
- Capture One 16.5.0 or later.
- [exiftool](https://exiftool.org/) (via Homebrew: `brew install exiftool`). Used for the capture-time pairing fallback.
- [pkfire](https://github.com/mizchi/pkfire) (`pkf`) and [Bun](https://bun.sh/) to build. `pkf` orchestrates the build tasks; `bunx tsc` type-checks and emits JS with zero install.
- Permissions for the process that launches the script (Raycast, Terminal, or Capture One itself when launched from its Scripts menu):
  - Automation (Apple Events to Capture One) for dictionary scripting such as selecting variants.
  - Accessibility for the Match Look menu clicks (System Events UI scripting). Without it, Match Look cannot run.

## Build and install

The build is defined in `Taskfile.pkl` and driven by `pkf`. The source is a single TypeScript file, `src/matchlook_pipeline.ts`, compiled to JS by `tsc` and then to a `.scpt` by `osacompile`.

```
pkf run build      # type-check + emit JS + compile .scpt
pkf run install    # copy the .scpt into ~/Library/Scripts/Capture One Scripts/
```

Build outputs land in `src/dist/` (git-ignored).

## Usage

Run with Capture One open on a session that follows the folder contract below.

```
pkf run sel                    # Match Look on the DNGs currently selected in Capture One (fast)
pkf run all                    # Match Look on the whole Denoised folder (about 27 min for 76 images)
pkf run all --matchlook=false  # pairing + manifest only, no Match Look (non-destructive)
pkf run sel --matchlook=false  # same, scoped to the current selection
```

- Raycast: register `scripts/raycast/match-look-all.sh` and `scripts/raycast/match-look-sel.sh` as Script Commands. Each wrapper cd's to the repo root and invokes `$HOME/.local/bin/pkf run`, so it assumes `pkf` is installed at `~/.local/bin/pkf`; edit the wrapper if yours lives elsewhere on `PATH`.
- Capture One Scripts menu: after `pkf run install`, launch the `.scpt` from Capture One's Scripts menu. With no environment set, the default is `scope=sel` and `matchlook=true` (apply to the current selection).

Execution scope (`all` / `sel`) and Match Look on/off are selected via the `SCOPE` and `MATCHLOOK` environment variables, which `pkf` passes to `osascript`; the script reads them with `app.systemAttribute`. Menu launch (no env) falls back to `scope=sel` and the `CONFIG.runMatchLook` default.

## Session folder contract

Paths are relative to the Capture One session root.

| Path | Contents |
|---|---|
| `Selects/Denoised/` | PureRAW output DNGs (pairing input; the scan target for `all`) |
| `References/` | Creative-look JPEGs (pairing input) |
| `Output/matchlook_pairs.tsv` | Pairing manifest, overwritten every run |

The manifest is a TSV with one row per DNG: its paired JPEG (session-relative), how the pair was found (by name or by capture time), and whether Match Look was applied, skipped, or the reference variant could not be resolved. No images are copied, so large sessions add no storage cost.

## How it works

1. Pairing. Each JPEG in `References/` is indexed by base name and, as a fallback, by `DateTimeOriginal` (via exiftool). Each DNG is matched to a JPEG by name first; in `all` mode the capture-time fallback is tried when the name misses.
2. Match Look. Capture One's scripting dictionary has no Match Look command, so the script drives the UI: it selects the reference JPEG, clicks Adjustments > Set Match Look Reference, selects the target DNG, and clicks Adjustments > Apply Match Look. Because `variants()` is scoped to the current collection, the script temporarily switches the browser to the all-images smart album so the DNG and JPEG are visible together, then restores the original collection. In the all-images view the same base name appears as ARW, JPG, and DNG, so variants are disambiguated by the parent image's extension.
3. Manifest. The pairing result is written to `Output/matchlook_pairs.tsv` (see above).

## Scripting dictionary

Capture One's scripting dictionary is not redistributed here. To inspect it yourself, open Script Editor, choose File > Open Dictionary, and select Capture One (or use Capture One's own Open Scripting Dictionary). This is how the "no Match Look command" fact above was verified.

## Known limitations

- Match Look is not in the scripting dictionary. The UI menu route is the only path, and it requires Accessibility permission for the launcher. The menu labels are UI-language dependent (`CONFIG.menuMatchLook`).
- All-images collection dependency. Because `variants()` is scoped to the current collection, the script switches to an all-images smart album whose name is UI-language dependent (`CONFIG.allImagesCollection`, e.g. the Japanese "すべてのイメージ"). Set it to match your Capture One display language.
- Menu enablement is asynchronous. After selecting a variant, the target menu item becomes enabled with a delay, so the script polls the enabled state before clicking rather than using a fixed delay.
- All-mode runtime is long: about 27 minutes for 76 images, dominated by waiting on menu enablement. `sel` is fast for a handful of images.
- Destructive on adjusted images. `all` with Match Look writes directly into each DNG's adjustment settings (it does not remain as a reusable style, and undo is murky). Back up the session `.cosessiondb` (or enable Time Machine) before running `all` on a session that already contains adjustments.
- PureRAW suffixes. If your PureRAW output DNGs carry a suffix, add it to `CONFIG.stripSuffixes` (for example `['-dxo']`) so the base names match.
- The PureRAW hand-off stage (sending RAWs to PureRAW) is not implemented.

## License

MIT. See [LICENSE](LICENSE).
