# Release qqdict for macOS

Releases contain separate Apple Silicon (`arm64`) and Intel (`x64`) builds. The Electron runtime and Swift bridge must target the same architecture. Build on macOS; there is no Windows or Linux package.

## Local preview

With Node.js 22.12 or later, Xcode Command Line Tools, and installed dependencies:

```sh
npm ci
npm test
npm run dist:mac
```

The installer builder produces versioned DMG and ZIP files in `release/`, plus a SHA-256 manifest for that architecture. For version 0.5.3:

```text
qqdict-0.5.3-mac-arm64.dmg
qqdict-0.5.3-mac-arm64.zip
SHA256SUMS-arm64.txt
```

Intel builds use `x64` in place of `arm64`. Verify each architecture separately before describing it as tested. The local Apple Silicon test run does not verify the Intel app.

Without configured Apple credentials, these are **ad hoc signed, unnotarized previews**. The release description must say so and link to [first-launch instructions](install.md). Do not describe ad hoc signing as Developer ID signing or notarization.

## GitHub release workflow

The workflow runs tests and builds on macOS runners for both architectures when a `v*` tag is pushed. Keep `package.json`, the lockfile, and the tag version consistent. Use a `v` prefix with the package version, for example `v0.5.3`.

The workflow publishes versioned assets to the GitHub release, including a `release-metadata-{arch}.json` file that records signing status. Check both jobs and inspect the downloadable assets before announcing the release. Unnotarized previews are prereleases. The README links directly to `v0.5.3`; update its versioned links for each release. GitHub’s `/releases/latest` link skips prereleases and is suitable once a stable notarized release is available.

## Developer ID signing and notarization

Public distribution can use an Apple Developer account with a **Developer ID Application** certificate. Keep the certificate and authentication material out of the repository.

Configure these repository Actions secrets for certificate import and signing:

| Secret | Purpose |
| --- | --- |
| `DEVELOPER_ID_APPLICATION` | The signing identity’s exact name, such as `Developer ID Application: …`. |
| `MACOS_CERTIFICATE_P12_BASE64` | Base64-encoded export of the Developer ID Application certificate and private key. |
| `MACOS_CERTIFICATE_PASSWORD` | Password protecting that certificate export. |

For CI notarization, also configure:

| Secret | Purpose |
| --- | --- |
| `APPLE_ID` | Apple account used for notarization. |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that account. |
| `APPLE_TEAM_ID` | Apple Developer team ID. |

For a local notarization run, a configured `APPLE_KEYCHAIN_PROFILE` can be used instead of passing those account variables. Store credentials with Apple’s `notarytool`; never commit them, print them in logs, or put them in a release description.

The packaging flow must sign nested code with the hardened runtime, verify the bundle, submit the installer for notarization, wait for acceptance, and staple the ticket. A successful build alone is not evidence of notarization. Only advertise a notarized release after acceptance and verification finish.

## Before publishing

Run the automated tests and native helper checks. On each supported architecture, manually verify onboarding, hold-to-record, release-to-stop, focused-field paste, transcript recovery, journal creation, and island movement. Check that no private transcript, local history, account credential, or development screenshot is included in the archive.
