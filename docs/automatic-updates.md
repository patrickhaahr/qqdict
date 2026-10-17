# Automatic updates

Production releases containing the updater check for newer stable GitHub Releases about 15 seconds after launch, every hour, and when the Mac wakes. Downloads happen in the background using the correct Apple Silicon or Intel ZIP. Electron verifies the app's code signature and handles replacing the installed bundle.

When a download is ready, qqdict offers **Restart now** or **Later**. Later leaves the update staged for the next app launch. You can also choose **Restart to update…** by right-clicking the menu bar icon or opening the **qqdict** application menu while Settings is focused. These menus offer **Check for updates…** when no update is staged.

Restart waits for recording, transcription, history and journal writes, and automatic paste cleanup. No new recording starts while a requested restart is pending. A failed final history save keeps the app open so the in-memory transcript can be recovered. Background network errors remain quiet; a manual check reports success or failure. The update prompt waits while the screen is locked or the Mac is asleep.

## Enable the first release

Downloads of **0.5.5** and earlier do not contain the updater. Install **0.5.6**, the first release with this feature, manually once. All later updates can arrive through the app.

1. Configure the six GitHub Actions signing and notarization secrets listed in [releasing.md](releasing.md#github-release-workflow), or use that document's local signed release process. Keep the production bundle ID and Developer ID signing team consistent between versions.
2. Increase `package.json` to a new stable version, for example **0.5.6**, and update the versioned README and installation links for that release. Commit the implementation, including the new files. Push the matching `v0.5.6` tag after the code is ready to release.
3. Let both architecture jobs complete. The release must contain the signed, notarized `.zip` files as well as the `.dmg` installers. The workflow uploads new releases as drafts and publishes only after both architectures are present. Notarized beta versions and unnotarized previews stay prereleases.
4. Download the release, drag qqdict into **Applications**, and open the installed copy. Existing users do this once for the updater's first release. Preserve the app's settings and journal folders when replacing the app.
5. Test a subsequent signed version on Apple Silicon and Intel before announcing automatic updates as verified on both architectures. Use the checklist below.

No new server, GitHub token inside the app, or additional updater secret is needed. The public repository and release ZIP filenames already match [Electron's update service](https://github.com/electron/update.electronjs.org#readme).

## Release requirements

The packager writes `Contents/Resources/update-config.json` before signing the app. `enabled` is true only for a production build with Developer ID signing and requested notarization. Failed notarization prevents that staged app from becoming a release artifact. Runtime checks also require the configuration's version, architecture, and bundle ID to match the installed app.

Nightly, source builds, previews without notarization, and apps running outside Applications do not check the production feed. **Check for updates…** explains why updates are unavailable for these builds. Nightly keeps its separate app identity and data. Drafts and prereleases are excluded by the update service.

Keep uploading both of these ZIPs alongside the DMGs, substituting the actual version:

```text
qqdict-0.5.6-mac-arm64.zip
qqdict-0.5.6-mac-x64.zip
```

Once a stable release is published, its assets are immutable in the workflow. Publish fixes under a new version and tag; replacing an existing ZIP could affect an update already being downloaded.

Check the public feed after publishing. Querying from `0.0.0` should return JSON pointing to the newest stable ZIP for each architecture; querying from the current stable version should return HTTP 204. The service caches release information, so a newly published release may take time to appear.

```sh
curl --fail --silent --show-error https://update.electronjs.org/qwertyu-alex/qqdict/darwin-arm64/0.0.0
curl --fail --silent --show-error https://update.electronjs.org/qwertyu-alex/qqdict/darwin-x64/0.0.0
```

## Verify an installed update

Use two successive signed, notarized production versions. Keep the older version installed in Applications, with its own version in `update-config.json`. Publish the newer one as a stable GitHub Release only when both architectures are ready. A source or ad hoc build cannot validate macOS's signed installation path.

- While recording or transcribing, let the newer version download. The app must finish saving and pasting before it offers a restart.
- Choose **Later**. Dictation remains available, **Restart to update…** stays in the menus, and the app must not repeatedly prompt during the same session. Quit and relaunch to verify installation on the next launch.
- For a separate update run, choose **Restart now**. Confirm the new version in About, along with retained settings, recent history, journal, and macOS permission access.
- Start a take while the restart dialog is open, then choose Restart now. The update waits for that take and clipboard cleanup to settle, and prevents another take from starting while restart is pending.
- Test a failed manual check offline and a successful retry online. Background failures must not open dialogs or block dictation.
- Verify these paths on each supported Mac architecture. Unit tests exercise the coordinator and release publication but do not replace a signed app-to-app upgrade test.

Update checks contact `update.electronjs.org`; ZIP downloads come from GitHub. Requests disclose the app version, platform, architecture, and ordinary network metadata. They do not include recordings, transcripts, or Codex credentials.
