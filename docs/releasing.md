# Release qqdict for macOS

Releases contain separate Apple Silicon (`arm64`) and Intel (`x64`) builds. The Electron runtime and Swift bridge must target the same architecture. Build on macOS; there is no Windows or Linux package.

## App icon

`assets/app-icon.png` is the source logo used by the README and About panel. After changing it, run `pnpm run build:icon` on a Mac to regenerate `assets/AppIcon.icns` for Finder, the Dock, and installers. Commit both assets together.

## Release files

Use Node.js 22.12 or later, pnpm 10.9.0, and Xcode Command Line Tools on a Mac. The installer builder produces versioned DMG and ZIP files in `release/`, plus a SHA-256 manifest and signing metadata for that architecture. For version 0.5.5:

```text
qqdict-0.5.5-mac-arm64.dmg
qqdict-0.5.5-mac-arm64.zip
SHA256SUMS-arm64.txt
release-metadata-arm64.json
```

Intel builds use `x64` in place of `arm64`. Verify each architecture separately before describing it as tested. The local Apple Silicon test run does not verify the Intel app.

## Local signed and notarized release

Install a **Developer ID Application** certificate with its matching private key in your Mac’s Keychain. A downloaded `.cer` alone is insufficient on another Mac: that Mac also needs the private key generated with the certificate signing request. Keep the key and authentication material out of the repository.

Find the identity’s exact name:

```sh
security find-identity -v -p codesigning
```

Create an [Apple app-specific password](https://support.apple.com/102654), then store notarization credentials in the Keychain. Replace the example account and team ID with your own:

```sh
xcrun notarytool store-credentials qqdict-notary \
  --apple-id you@example.com \
  --team-id YOURTEAMID
```

Enter the app-specific password at the hidden prompt. Do not add `--password` to the command or put the password in shell history, chat, source files, or build logs. Apple validates the credentials before saving the profile.

Build using the exact signing identity and the saved profile. The identity below is an example; replace it with the name returned above:

```sh
pnpm install --frozen-lockfile
pnpm test
DEVELOPER_ID_APPLICATION='Developer ID Application: Your Name (YOURTEAMID)' \
APPLE_KEYCHAIN_PROFILE=qqdict-notary \
pnpm run dist:mac
```

The packaging flow signs nested code from the inside out with a secure timestamp and hardened runtime, then verifies the bundle. It submits an app ZIP to Apple, requires an **Accepted** response, staples and validates the app’s ticket, and checks the app with Gatekeeper. It then creates, signs, submits, and staples the DMG. The downloadable ZIP contains the stapled app.

Confirm the result before publishing a notarized stable release:

```sh
codesign --verify --deep --strict release/qqdict.app
xcrun stapler validate release/qqdict.app
spctl --assess --type execute release/qqdict.app
xcrun stapler validate release/qqdict-0.5.5-mac-arm64.dmg
```

Use the appropriate version and architecture in the DMG path. Inspect each `release-metadata-{arch}.json`: `signing` and `diskImageSigning` must both be `developer-id`, and `notarized` and `diskImageNotarized` must both be `true`. A successful build or certificate alone is not evidence of notarization.

## GitHub release workflow

The workflow runs tests and builds on macOS runners for both architectures when a `v*` tag is pushed. Keep `package.json`, the lockfile, and the tag version consistent. Use a `v` prefix with the package version, for example `v0.5.5`.

The local Keychain profile is available only on your Mac. GitHub Actions needs its own certificate import and notarization configuration. Export the Developer ID Application certificate **and private key** together as a password-protected `.p12`, then configure all six repository Actions secrets:

| Secret | Purpose |
| --- | --- |
| `DEVELOPER_ID_APPLICATION` | The signing identity’s exact name, such as `Developer ID Application: Your Name (YOURTEAMID)`. |
| `MACOS_CERTIFICATE_P12_BASE64` | Base64-encoded export of the Developer ID Application certificate and private key. |
| `MACOS_CERTIFICATE_PASSWORD` | Password protecting that certificate export. |
| `APPLE_ID` | Apple account used for notarization. |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that account. |
| `APPLE_TEAM_ID` | Apple Developer team ID. |

Do not commit the `.p12`, its Base64 contents, or any password. The workflow imports the certificate into a temporary signing Keychain and removes that Keychain after the build. The app-specific password is passed through Actions secrets; it is not the password for your Apple account.

The workflow publishes versioned assets and signing metadata. Check both jobs and inspect the downloadable assets before announcing the release. Unnotarized builds are prereleases. The README links directly to `v0.5.5`; update its versioned links for each release. GitHub’s `/releases/latest` link skips prereleases and can be used for stable notarized releases.

For a locally signed release without CI credentials, reserve the version as a GitHub draft **without** the prerelease flag before pushing its tag. Upload the verified local installers, checksums, and both architectures’ metadata before publishing the draft. Publish pending notarization as a prerelease; publish as stable only after app and DMG notarization verifies. The workflow protects stable releases and non-prerelease drafts from preview publication, and also preserves Developer ID signed prereleases from unsigned CI builds.

## Local preview

With no signing or notarization variables configured:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run dist:mac
```

These builds are **ad hoc signed, unnotarized previews**. The release description must say so and link to [first-launch instructions](install.md). Do not describe ad hoc signing as Developer ID signing or notarization, or replace signed release assets with preview builds.

A Developer ID–signed build awaiting Apple notarization can also be published as a prerelease. Describe it as **signed, not yet notarized**, preserve that status in its metadata, and link to the first-launch guide. Update the downloads and signing claims only after Apple accepts the submissions and the stapled tickets verify.

## Before publishing

Run the automated tests and native helper checks. On each supported architecture, manually verify onboarding, hold-to-record, release-to-stop, focused-field paste, transcript recovery, journal creation, and island movement. Check that no private transcript, local history, account credential, or development screenshot is included in the archive.
