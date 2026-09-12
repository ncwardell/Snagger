{
  description = "Snagger - IPTV M3U/EPG aggregator and manager";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            sqlite
            python3          # Tubi Widevine CDM key fetch (helpers/wvcdm.py + .venv)
            bento4           # mp4decrypt — CENC fMP4 decryption for Tubi DRM
            dotnet-sdk_8     # Emby plugin (IChannel) build — Emby 4.9 targets .NET 8
            unzip            # extract Emby reference assemblies from the netcore zip
          ];

          # Keep .NET from phoning home / writing to $HOME during CI-ish builds.
          DOTNET_CLI_TELEMETRY_OPTOUT = "1";
          DOTNET_SKIP_FIRST_TIME_EXPERIENCE = "1";

          shellHook = ''
            echo "snagger dev shell"
            echo "  bun         $(bun --version)"
            echo "  sqlite      $(sqlite3 --version | cut -d' ' -f1)"
            echo "  dotnet      $(dotnet --version 2>/dev/null || echo MISSING)"
            echo "  mp4decrypt  $(command -v mp4decrypt >/dev/null && echo ok || echo MISSING)"
            # One-time: create the pywidevine venv (Tubi Widevine CDM).
            # (Pluto VOD is browser-free — pure HTTP token flow in sources/PlutoTV.ts.)
            if [ ! -x .venv/bin/python ]; then
              echo "  setting up .venv (pywidevine)…"
              ${pkgs.python3}/bin/python3 -m venv .venv && \
                .venv/bin/pip -q install --upgrade pip pywidevine requests
            fi
            echo "  cdm         $([ -f device.wvd ] && echo "device.wvd present" || echo "device.wvd MISSING")"
          '';
        };
      });
}
