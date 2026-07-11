# Capture One Match Look Pipeline

A macOS automation script that applies Capture One's Match Look feature to the RAW target(s) currently selected in Capture One, using a same-basename creative-look JPEG already imported into the same session as the reference.

The workflow it automates: you shoot RAW+JPEG (the JPEG carries a creative look / picture profile). Optionally develop the RAW into a clean DNG with DxO PureRAW; if you skip PureRAW, work from the ARW directly. Select the RAW target(s) in Capture One and run the script: for each one, it finds the same-named creative-look JPEG already imported into the session, sets it as the Match Look reference, applies the look to the target, and appends the result to a pairing log.

## Requirements

- macOS only (the script is JXA / AppleScript-driven and controls Capture One through Apple Events and UI scripting).
- Capture One 16.5.0 or later.
- [pkfire](https://github.com/mizchi/pkfire) (`pkf`) and [Bun](https://bun.sh/) to build. `pkf` orchestrates the build tasks; `bunx tsc` type-checks and emits JS with zero install.
- Permissions for the process driving the script:
  - Terminal or Raycast: that process needs Automation (Apple Events to Capture One) for dictionary scripting such as selecting variants, and Accessibility for the Match Look menu clicks (System Events UI scripting).
  - Capture One's own Scripts menu: launching this way makes Capture One itself the controlling process, so Capture One needs Automation permission to System Events plus Accessibility. See Troubleshooting below if this surfaces as AppleScript error -10004.

## Build and install

The build is defined in `Taskfile.pkl` and driven by `pkf`. The source is a single TypeScript file, `src/matchlook_pipeline.ts`, compiled to JS by `tsc` and then to a `.scpt` by `osacompile`.

```
pkf run build      # type-check + emit JS + compile .scpt
pkf run install    # copy the .scpt into ~/Library/Scripts/Capture One Scripts/, listed there as "Apply Match Look from Reference"
pkf run test       # run the pure-logic unit tests (node --test)
```

Build outputs land in `src/dist/` (git-ignored).

## Usage

Run with Capture One open, the RAW target selected in the browser, and its creative-look JPEG already imported somewhere in the same session.

```
pkf run sel    # apply Match Look to the target(s) currently selected in Capture One
```

- Raycast: register `scripts/raycast/match-look-sel.sh` as a Script Command. The wrapper cd's to the repo root and invokes `$HOME/.local/bin/pkf run sel`, so it assumes `pkf` is installed at `~/.local/bin/pkf`; edit the wrapper if yours lives elsewhere on `PATH`.
- Capture One Scripts menu: after `pkf run install`, launch "Apply Match Look from Reference" from Capture One's Scripts menu. It runs the same behavior as `pkf run sel` against whatever is currently selected.

## Session folder contract

There is no required folder layout. What matters is that the RAW target and its creative-look JPEG are both imported into the same Capture One session as same-basename variants (the accepted RAW extensions are defined in `CONFIG.rawTargetExts`). PureRAW is optional: with PureRAW the target is the denoised DNG; without it, select the ARW directly. The script locates the pair itself by switching to the All Images smart album, matching basenames, applying Match Look, and restoring the original collection afterward.

Pairing results are appended to a log at a fixed path relative to the session root:

| Path | Contents |
|---|---|
| `Output/matchlook_pairs.tsv` | Pairing log, appended to on every run (header written once) |

Each row records the run timestamp, the target's name, the matched JPEG's name (or `-` if none was found), and whether Match Look was applied, could not resolve the reference variant (`no-ref`), or found no matching JPEG (`-`). No images are copied, so large sessions add no storage cost.

## How it works

1. Selection. The script reads the variant(s) currently selected in Capture One's browser, keeping only those whose parent image extension matches `CONFIG.rawTargetExts`.
2. Collection switch. Because `variants()` is scoped to the current collection, the script switches to the all-images smart album so the target and its JPEG are both visible together, then restores the original collection afterward.
3. Match Look. Capture One's scripting dictionary has no Match Look command, so the script drives the UI: it selects the reference JPEG, clicks Adjustments > Set Match Look Reference, selects the target, and clicks Adjustments > Apply Match Look. In the all-images view the same base name can appear under more than one extension, so variants are disambiguated by the parent image's extension.
4. Log. The pairing result for each target is appended to `Output/matchlook_pairs.tsv` (see above).

## Scripting dictionary

Capture One's scripting dictionary is not redistributed here. To inspect it yourself, open Script Editor, choose File > Open Dictionary, and select Capture One (or use Capture One's own Open Scripting Dictionary). This is how the "no Match Look command" fact above was verified.

## Troubleshooting

### AppleScript error -10004 (privilege violation)

Running from Capture One's Scripts menu makes Capture One the controlling
process, so it needs permission to drive the UI:

- System Settings > Privacy & Security > Automation > Capture One > enable
  "System Events".
- System Settings > Privacy & Security > Accessibility > enable "Capture One".

If a prompt was previously denied it will not reappear. Force a fresh prompt:

    tccutil reset AppleEvents com.captureone.captureone16

Then relaunch Capture One and run the script once to grant access.

## Known limitations

- Match Look is not in the scripting dictionary. The UI menu route is the only path, and it requires Accessibility permission for the launcher. The menu labels are UI-language dependent (`CONFIG.menuMatchLook`).
- All-images collection dependency. Because `variants()` is scoped to the current collection, the script switches to an all-images smart album whose name is UI-language dependent (`CONFIG.allImagesCollection`, e.g. the Japanese "すべてのイメージ"). Set it to match your Capture One display language.
- Menu enablement is asynchronous. After selecting a variant, the target menu item becomes enabled with a delay, so the script polls the enabled state before clicking rather than using a fixed delay.
- Same-basename collisions. The all-images view can show the same base name under multiple extensions; the script disambiguates by the parent image's extension, and this must be preserved in any refactor.
- PureRAW suffixes. If your PureRAW output DNGs carry a suffix, add it to `CONFIG.stripSuffixes` (for example `['-dxo']`) so the base names match.
- The PureRAW hand-off stage (sending RAWs to PureRAW) is not implemented.
- Match Look writes directly into the target's adjustment settings (it does not remain as a reusable style, and undo is murky). Back up the session `.cosessiondb` (or enable Time Machine) before running on a session that already contains adjustments you want to keep.

## License

MIT. See [LICENSE](LICENSE).
