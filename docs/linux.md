# qqdict on Linux

qqdict runs on Wayland desktops. A small Node helper (`src/linux-bridge.ts`) replaces the macOS Swift bridge and speaks the same protocol:

- **Shortcut:** read from the keyboard devices in `/dev/input`. Only the set of currently held keys is kept, never typed text.
- **Paste:** the transcript is staged with `wl-copy` and pasted with `wtype` or `ydotool`. The previous clipboard is put back afterwards.
- **Focus check:** the niri, Hyprland, or sway IPC confirms that the window you dictated into still has focus.

The default shortcut is **Right Ctrl**. **Right Alt** and **Ctrl + Alt** are available in Settings. On layouts where Right Alt is AltGr, keep Right Ctrl. Pressing any ordinary key while the shortcut is held, as in Ctrl+C, cancels the take.

## Requirements

- A Wayland session.
- `wl-clipboard` (`wl-copy` and `wl-paste`).
- A paste tool:
  - `wtype` on compositors with the virtual-keyboard protocol: niri, Hyprland, sway and other wlroots compositors.
  - `ydotool` with a running `ydotoold` on GNOME and KDE.
- Read access to `/dev/input/event*`, which usually means membership of the `input` group.
- A signed-in Codex installation. qqdict looks for `codex` on `PATH`, in `~/.nix-profile/bin`, `/etc/profiles/per-user/$USER/bin`, `/run/current-system/sw/bin`, `~/.local/bin`, and `/usr/local/bin`.

The Setup tab names whichever of these is missing. Its **Check again** button re-runs the checks.

## NixOS

Build and run this checkout (the Linux port is in this fork):

```sh
nix run .
```

Or install it in your configuration:

```nix
# flake inputs
qqdict.url = "github:patrickhaahr/qqdict";

# configuration.nix
environment.systemPackages = [ inputs.qqdict.packages.${pkgs.system}.default ];
users.users.<you>.extraGroups = [ "input" ];
```

The GitHub input requires these changes to be pushed to the fork. For a local flake input, use `qqdict.url = "path:/absolute/path/to/qqdict";`.

The package runs nixpkgs' `electron_44` and adds `wl-clipboard` and `wtype` to its `PATH`. After joining the `input` group, log out and back in. The `input` group grants access to keyboard events across applications; qqdict needs it to detect a held modifier on Wayland.

The Nix package uses the production identity (`qqdict`, with journals in `~/Dictation`). Linux updates are managed by Nix; the upstream macOS automatic updater stays disabled.

For GNOME or KDE, enable ydotool instead of wtype:

```nix
programs.ydotool.enable = true;
users.users.<you>.extraGroups = [ "input" "ydotool" ];
```

**Open at login** writes `~/.config/autostart/qqdict.desktop`. It is available when qqdict was started from the installed `qqdict` launcher. Compositors that don't run XDG autostart entries need their own startup command; for niri, add `spawn-at-startup "qqdict"`.

## Window rules

The floating status island is titled `qqdict status`. The recent-transcripts popover is titled `qqdict · Recent`. Tiling compositors should float both and keep focus where you are typing. For niri:

```kdl
window-rule {
    match app-id="^qqdict$" title="^qqdict (status|· Recent)$"
    open-floating true
}
window-rule {
    match app-id="^qqdict$" title="^qqdict status$"
    open-focused false
}
```

For current Hyprland Lua configuration, use [window rules](https://wiki.hypr.land/configuring/core/rules/window-rules/):

```lua
hl.window_rule({
    match = { class = "^qqdict$", title = "^qqdict (status|· Recent)$" },
    float = true,
})
hl.window_rule({
    match = { class = "^qqdict$", title = "^qqdict status$" },
    no_focus = true,
})
```

If the island takes focus anyway, qqdict hands focus back to the original window before pasting.

The tray icon needs a StatusNotifierItem host, for example waybar's `tray` module. Left-click opens recent transcripts. Right-click shows a menu with Settings and Quit.

## Development

```sh
nix develop          # Node 24, pnpm 10, electron_44, wl-clipboard, wtype
pnpm install --frozen-lockfile
pnpm test
pnpm run build && pnpm exec electron .
```

The dev shell sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1` and points `ELECTRON_OVERRIDE_DIST_PATH` at nixpkgs' Electron, because the binary from npm is not linked for NixOS. On other distributions, install the requirements above, then run `pnpm install --frozen-lockfile` and `pnpm start`; installation downloads Electron as usual. Linux needs no Swift toolchain.

Upstream source builds now default to **qqdict Nightly**, with separate settings and journals in `~/Dictation Nightly`. Use `QQDICT_CHANNEL=production pnpm start` to build with the installed package's identity and the window rules above.

When `pnpm-lock.yaml` changes, update the `hash` in `nix/package.nix`. Set it to `lib.fakeHash`, run `nix build`, and copy the reported hash.

## Limitations

- **Wayland only.** X11 sessions are not supported.
- **One clipboard format is restored.** `wl-copy` offers a single format, so qqdict saves the richest one (an image, otherwise text) and restores that. Rich-text formats from the same copy are lost.
- **No field or password detection.** Wayland doesn't expose the focused text field, so qqdict checks the window instead. Dictating with no text field focused pastes into whatever the window does with Ctrl+V. It cannot identify protected fields on Linux.
- **Clipboard ownership is inferred from text.** If you copy exactly the staged transcript during automatic paste, qqdict cannot distinguish that copy from its own clipboard and may restore the previous content.
- **Window placement is compositor-controlled.** Wayland may ignore the island's saved screen position and dragging; use compositor rules where needed.
- Terminals are detected by app id and receive Ctrl+Shift+V.
- Without niri, Hyprland or sway IPC, qqdict pastes without checking that focus is unchanged.
