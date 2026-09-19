{
  description = "Niri-glass: niri with a liquid-glass / refraction background effect";

  inputs = {
    # Pinned to the exact upstream niri revision these overlay files were
    # written against (niri 26.04, rev 49fc611). The overlay replaces whole
    # source files, so it must be built against this base. Bump this rev only
    # together with refreshed overlay files.
    niri = {
      url = "github:YaLTeR/niri/49fc6117fd6c043adaa2ead316b82db5ed735d36";
    };

    # Our own nixpkgs for tooling (devShell, formatter). The niri *package*
    # keeps niri's pinned nixpkgs to maximise binary-cache parity with upstream.
    nixpkgs.follows = "niri/nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      niri,
    }:
    let
      inherit (nixpkgs) lib;

      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = lib.genAttrs systems;
      pkgsFor = forAllSystems (system: nixpkgs.legacyPackages.${system});

      # Overlay the liquid-glass source files onto a base niri derivation.
      # The overlay touches no Cargo.toml / Cargo.lock, so the vendored
      # dependency set (and its hash) is identical to upstream niri — only the
      # `niri` crate itself recompiles.
      applyGlass =
        name: base:
        base.overrideAttrs (old: {
          pname = name;
          postPatch = (old.postPatch or "") + ''
            echo "==> Applying Niri-glass liquid-glass overlay"
            chmod -R u+w src/render_helpers niri-config/src
            cp --no-preserve=mode ${./src/render_helpers/liquid_glass.rs}            src/render_helpers/liquid_glass.rs
            cp --no-preserve=mode ${./src/render_helpers/background_effect.rs}       src/render_helpers/background_effect.rs
            cp --no-preserve=mode ${./src/render_helpers/framebuffer_effect.rs}      src/render_helpers/framebuffer_effect.rs
            cp --no-preserve=mode ${./src/render_helpers/xray.rs}                    src/render_helpers/xray.rs
            cp --no-preserve=mode ${./src/render_helpers/mod.rs}                     src/render_helpers/mod.rs
            cp --no-preserve=mode ${./src/render_helpers/shaders/clipped_surface.frag} src/render_helpers/shaders/clipped_surface.frag
            cp --no-preserve=mode ${./src/render_helpers/shaders/mod.rs}             src/render_helpers/shaders/mod.rs
            cp --no-preserve=mode ${./niri-config/src/appearance.rs}                 niri-config/src/appearance.rs
          '';
          meta = (old.meta or { }) // {
            description = "niri with a liquid-glass / refraction background effect";
          };
        });

      packagesFor = system: rec {
        niri-glass = applyGlass "niri-glass" niri.packages.${system}.niri;
        niri-glass-debug = applyGlass "niri-glass-debug" niri.packages.${system}.niri-debug;
        default = niri-glass;
      };
    in
    {
      packages = forAllSystems packagesFor;

      # `nix run` / `nix run .#niri-session`
      apps = forAllSystems (
        system:
        let
          pkgs = (packagesFor system).niri-glass;
        in
        {
          default = {
            type = "app";
            program = "${pkgs}/bin/niri";
            meta.description = "Run the niri-glass compositor";
          };
          niri-session = {
            type = "app";
            program = "${pkgs}/bin/niri-session";
            meta.description = "Run niri-glass as a systemd user session";
          };
        }
      );

      # `nix develop` — full niri build environment for hacking on the overlay.
      # NOTE: this repo only contains overlay files (no Cargo.toml). To build,
      # apply the overlay onto a checkout of niri @ 49fc611 (see ./install.sh)
      # and run `cargo build --release` from there inside this shell.
      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor.${system};
          niriGlass = (packagesFor system).niri-glass;
          rustfmt' = pkgs.rustfmt.override { asNightly = true; };
        in
        {
          default = pkgs.mkShell {
            inputsFrom = [ niriGlass ];
            packages = builtins.attrValues {
              inherit (pkgs)
                rustc
                cargo
                clippy
                rust-analyzer
                cargo-insta
                ;
              inherit rustfmt';
            };
            # Required for `dlopen()` of libEGL / libwayland-client; see the
            # upstream niri package expression. Do not overwrite, only append.
            RUSTFLAGS = niriGlass.RUSTFLAGS or "";
            shellHook = ''
              echo "niri-glass dev shell — Rust + niri build deps ready."
              echo "This repo is an overlay; build against a niri @ 49fc611 checkout."
            '';
          };
        }
      );

      overlays.default = final: _prev: {
        niri-glass = applyGlass "niri-glass" (niri.packages.${final.stdenv.hostPlatform.system}.niri);
      };

      nixosModules.default = import ./nix/nixos-module.nix self;
      homeManagerModules.default = import ./nix/home-manager-module.nix self;

      formatter = forAllSystems (system: pkgsFor.${system}.nixfmt-rfc-style);
    };
}
