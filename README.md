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

There is no required folder layout. What matters is that the RAW target and its creative-look JPEG are both imported into the same Capture One session as same-basename variants (the accepted RAW extensions are defined in `CONFIG.rawTargetExts`). PureRAW is optional: with PureRAW the target is the denoised DNG; without it, select the ARW directly. The script locates the pair itself by switching to the collection with the most variants (excluding the trash), matching basenames, applying Match Look, and restoring the original collection afterward.

Pairing results are appended to a log at a fixed path relative to the session root:

| Path | Contents |
|---|---|
| `Output/matchlook_pairs.tsv` | Pairing log, appended to on every run (header written once) |

Each row records the run timestamp, the target's name, the matched JPEG's name (or `-` if none was found), and whether Match Look was applied, applying Match Look failed after a JPEG was found (`no-ref`), or no matching JPEG was found (`-`). No images are copied, so large sessions add no storage cost.

## How it works

1. Selection. The script reads the variant(s) currently selected in Capture One's browser, keeping only those whose parent image extension matches `CONFIG.rawTargetExts`.
2. Collection switch. Because `variants()` is scoped to the current collection, the script switches to the collection with the most variants (excluding the trash) so the target and its JPEG are both visible together, then restores the original collection afterward.
3. Match Look. Capture One's scripting dictionary has no Match Look command, so the script drives the UI instead: it selects the reference JPEG and clicks the menu item that sets it as the Match Look reference, then selects the target and clicks the menu item that applies Match Look. Both menu items are resolved at runtime from `CONFIG.matchLookLabels` rather than a hardcoded menu path, so the exact label text lives only in that field. The same base name can appear under more than one extension in that collection, so the script disambiguates the JPEG lookup by the parent image's extension; the target itself is kept as the direct variant reference from the initial selection rather than looked up again.
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

- Match Look is not in the scripting dictionary. The UI menu route is the only path, and it requires Accessibility permission for the launcher. Menu labels are resolved at runtime by matching against a candidate list covering every language Capture One ships (`CONFIG.matchLookLabels`, regenerate with `pkf run labels`), so the display language does not matter.
- Collection switching. Because `variants()` is scoped to the current collection, the script switches to the largest collection excluding the trash. This is language independent, but it assumes that collection holds the reference JPEG. After switching, the script verifies the target can be selected there and fails loudly with a diagnostic if it cannot.
- Menu enablement is asynchronous. After selecting a variant, the target menu item becomes enabled with a delay, so the script polls the enabled state before clicking rather than using a fixed delay.
- Same-basename collisions. The working collection can show the same base name under multiple extensions; the script disambiguates the JPEG lookup by the parent image's extension, and this must be preserved in any refactor (the target is not looked up from the index, so this only affects resolving the JPEG).
- PureRAW suffixes. If your PureRAW output DNGs carry a suffix, add it to `CONFIG.stripSuffixes` (for example `['-dxo']`) so the base names match.
- The PureRAW hand-off stage (sending RAWs to PureRAW) is not implemented.
- Match Look writes directly into the target's adjustment settings (it does not remain as a reusable style, and undo is murky). Back up the session `.cosessiondb` (or enable Time Machine) before running on a session that already contains adjustments you want to keep.

## License

MIT. See [LICENSE](LICENSE).
