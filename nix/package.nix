{
  lib,
  stdenv,
  nodejs_24,
  pnpm_10,
  fetchPnpmDeps,
  pnpmConfigHook,
  makeWrapper,
  makeDesktopItem,
  copyDesktopItems,
  electron_44,
  wl-clipboard,
  wtype,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "qqdict";
  version = (lib.importJSON ../package.json).version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
      ../tsconfig.json
      ../vite.config.mts
      ../index.html
      ../overlay.html
      ../popover.html
      ../src
      ../scripts
      ../.github/workflows/release.yml
      ../assets/app-icon.png
    ];
  };

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_10;
    fetcherVersion = 4;
    hash = "sha256-BAPOC85Pz47VvDHNCsjCoX3+fy32vmsC7XgAJw0Ayxo=";
  };

  nativeBuildInputs = [
    nodejs_24
    pnpm_10
    pnpmConfigHook
    makeWrapper
    copyDesktopItems
  ];

  env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
  env.QQDICT_CHANNEL = "production";

  buildPhase = ''
    runHook preBuild
    pnpm run build
    runHook postBuild
  '';

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    pnpm test
    runHook postCheck
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "qqdict";
      desktopName = "qqdict";
      comment = "Push-to-talk dictation";
      exec = "qqdict";
      icon = "qqdict";
      categories = [ "Utility" "Accessibility" ];
      startupWMClass = "qqdict";
    })
  ];

  installPhase = ''
    runHook preInstall

    app=$out/share/qqdict
    mkdir -p $app/node_modules $app/assets
    cp -r dist package.json $app/
    cp assets/app-icon.png $app/assets/
    # Everything except ws is bundled into dist.
    cp -rL node_modules/ws $app/node_modules/

    install -Dm644 assets/app-icon.png $out/share/icons/hicolor/512x512/apps/qqdict.png

    # QQDICT_EXEC lets "Open at login" write an autostart entry for this launcher.
    makeWrapper ${lib.getExe electron_44} $out/bin/qqdict \
      --add-flags $app \
      --unset ELECTRON_RUN_AS_NODE \
      --set QQDICT_EXEC $out/bin/qqdict \
      --suffix PATH : ${lib.makeBinPath [ wl-clipboard wtype ]}

    runHook postInstall
  '';

  meta = {
    description = "Push-to-talk dictation using your Codex sign-in";
    homepage = "https://github.com/qwertyu-alex/qqdict";
    license = lib.licenses.mit;
    mainProgram = "qqdict";
    platforms = lib.platforms.linux;
  };
})
