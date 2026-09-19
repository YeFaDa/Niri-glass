# Liquid Glass Effect for Niri

**[English](README.md)** | **[中文](README.zh-CN.md)**

## Effects added by this fork

Everything this fork changes lives on the kwin / AndroidLiquidGlass path
(`physical-refraction 0`). Two of the effects are ports of Kyant0's
AndroidLiquidGlass, and both are on by default.

### Seven-tap spectral dispersion — `fringing`

The refraction samples the backdrop **seven times**, offset along the refraction
direction as red → orange → yellow → green → cyan → blue → purple, then mixes the
channels back (`color.r` comes from red/orange/yellow/purple, and so on). The result
is a chromatic fringe on the rim, strongest wherever the displacement is largest —
i.e. right at the edge.

| value | what you see |
|---|---|
| `0` | off — a single sample, no colour separation |
| `0.2` | a subtle fringe (recommended) |
| `0.4`+ | the samples drift so far apart that it reads as three separate images rather than dispersion |

### Depth term — `depth-effect`

The edge normal of a plain rounded-rectangle SDF is exactly perpendicular to each
straight edge, so content along an edge only slides **sideways** — it never leans
toward the corner, and the turn happens abruptly inside the real corner arc.

`depth-effect` blends the **inward radial** into that normal:

```glsl
kwinNormal = normalize(fanNormal - depthEffect * normalize(position));
```

so the direction rotates progressively along the *whole* edge instead of only at the
corners. This is Kyant0's `depthEffect`, and it is what makes straight lines visibly
"wrap around" the corner instead of ending in a kink.

| value | what you see |
|---|---|
| `1` | reference behaviour |
| `0` | plain SDF normal — the corner reads as an elbow |

Combined with `corner-fan` (which decides *how wide* the corner arc is), these are
the two effects that give the kwin path its shape.

## Files

### Shader

- `src/render_helpers/shaders/clipped_surface.frag` - Main liquid glass effect shader (based on [kwin-effects-glass](https://github.com/4v3ngR/kwin-effects-glass))

### Rust (rendering)

- `src/render_helpers/liquid_glass.rs` - `LiquidGlassOptions` struct with effect parameters
- `src/render_helpers/background_effect.rs` - Liquid glass integration with background effect
- `src/render_helpers/framebuffer_effect.rs` - Uniform passing to shader (windows)
- `src/render_helpers/xray.rs` - Uniform passing to shader (xray)
- `src/render_helpers/shaders/mod.rs` - Uniform registration during shader compilation
- `src/render_helpers/mod.rs` - Module declaration for liquid_glass

### Niri Config

- `config.kdl` - Example configuration with liquid-glass enabled

## How to Apply

### Nix / NixOS — overlay onto your own niri (recommended)

This repo is a set of loose source files, not a fork that has to be built from a
pinned base. The intended way to use it is to overlay those files onto the niri
you already have, so your own nixpkgs, kernel and Rust toolchain stay in play.

```nix
# flake.nix: add the input
inputs.niri-glass.url = "github:YeFaDa/Niri-glass";
```

```nix
# wherever your nixpkgs overlays are defined (e.g. a configuration module)
{ config, lib, pkgs, inputs, ... }:
{
  nixpkgs.overlays = [
    (final: prev: {
      niri-glass = prev.niri.overrideAttrs (old: {
        pname = "niri-glass";
        postPatch = (old.postPatch or "") + ''
          echo "==> Applying Niri-glass liquid-glass overlay"
          chmod -R u+w src/render_helpers niri-config/src
          cp --no-preserve=mode ${inputs.niri-glass}/src/render_helpers/liquid_glass.rs src/render_helpers/liquid_glass.rs
          cp --no-preserve=mode ${inputs.niri-glass}/src/render_helpers/background_effect.rs src/render_helpers/background_effect.rs
          cp --no-preserve=mode ${inputs.niri-glass}/src/render_helpers/framebuffer_effect.rs src/render_helpers/framebuffer_effect.rs
          cp --no-preserve=mode ${inputs.niri-glass}/src/render_helpers/xray.rs src/render_helpers/xray.rs
          cp --no-preserve=mode ${inputs.niri-glass}/src/render_helpers/mod.rs src/render_helpers/mod.rs
          cp --no-preserve=mode ${inputs.niri-glass}/src/render_helpers/shaders/clipped_surface.frag src/render_helpers/shaders/clipped_surface.frag
          cp --no-preserve=mode ${inputs.niri-glass}/src/render_helpers/shaders/mod.rs src/render_helpers/shaders/mod.rs
          cp --no-preserve=mode ${inputs.niri-glass}/niri-config/src/appearance.rs niri-config/src/appearance.rs
        '';
      });
    })
  ];
}
```

Then point your session at the package:

```nix
programs.niri.package = pkgs.niri-glass;
```

> [!IMPORTANT]
> **Compatibility: tested on niri 26.04 only.** The overlay copies in whole
> source files (`background_effect.rs`, `appearance.rs`, `clipped_surface.frag`, …),
> so it has to be applied to a niri of that generation. On other versions it may
> fail to compile or behave unexpectedly. The overlay touches no
> `Cargo.toml` / `Cargo.lock`, so the vendored dependency set stays identical
> and only the `niri` crate recompiles.

### Nix / NixOS (flake, builds the base for you)

If you would rather not wire the overlay yourself, the repo also ships a flake
that builds the pinned base niri (rev `49fc611`, niri 26.04) with the overlay
already applied:

```bash
nix run github:YeFaDa/Niri-glass          # run the compositor
nix shell github:YeFaDa/Niri-glass        # drop niri-glass into a shell
nix develop github:YeFaDa/Niri-glass      # dev shell (rust + niri build deps)
nix build  github:YeFaDa/Niri-glass       # build, result at ./result
```

`nixosModules.default` / `homeManagerModules.default` provide the session wiring
on top of that package, and `packages.<system>.niri-glass` can be referenced
anywhere a package is expected.

### install.sh (non-Nix)

Clone the official repo and this one and run the install script:

```bash
git clone https://github.com/niri-wm/niri
git clone https://github.com/YeFaDa/Niri-glass
cd Niri-glass
```

```bash
./install.sh 
```
This will create a new wayland session. You will be able to choose in your login manager.

### Manual steps

1. Copy files to your niri `src/` directory
2. Run `cargo build --release` in the niri source
3. Copy `target/release/niri` to `/usr/bin/local/niri-glass` (requires sudo)

## Configuration

### Recommended configuration

One ratio decides how strong the edge looks:

```
A / H = (refraction-strength × 0.05) / edge-thickness
```

`A` is the peak rim displacement (px) and `H` is the refraction band width (px). **At A/H ≥ 1.5 the edge starts to mirror-fold**, and Kyant0's own demo runs at **2 : 1**. Smaller corner radii and narrower windows make the same numbers look stronger.

**① Matched to Kyant0 (recommended default)**

```kdl
window-rule {
    match app-id=".*"
    background-effect {
        blur true
        xray true                 // must be true, otherwise the edge has artifacts
        liquid-glass {
            physical-refraction 0 // 0 = kwin / AndroidLiquidGlass path (all of this fork's work)
            refraction-strength 4.8   // A/H = (4.8 × 0.05) / 0.12 = 2.0, i.e. Kyant0's demo ratio
            edge-thickness 0.12       // H = 0.12 × half the shorter side
            corner-fan 1.5            // virtual corner radius = radius × 1.5 (= Kyant0 gradRadius)
            depth-effect 1            // = Kyant0 depthEffect, leans the whole edge toward the corner
            fringing 0.2
            glow-weight 0.8
            edge-lighting 0.5
            lens-distortion 0
            saturation 0.95
            vibrancy 0.25
            adaptive-dim 0.15
            adaptive-boost 0.15
        }
    }
}
```

**② Crisper, almost no mirror-folding (A/H ≈ 1.2)**

```kdl
liquid-glass {
    physical-refraction 0
    refraction-strength 2.9   // A/H = (2.9 × 0.05) / 0.12 = 1.21
    edge-thickness 0.12
    corner-fan 1.5
    depth-effect 1
    fringing 0.15
    glow-weight 0.5
    edge-lighting 0.4
    saturation 0.95
    vibrancy 0.2
}
```

> `corner-fan` / `depth-effect` are already the code defaults; they are shown here only to be self-documenting.
> Raise `corner-fan` to spread the corner turn further, but **above 3 the corner folds back into a loop**.

### Parameters

#### Refraction (core)

| Parameter | Default | Effect |
|---|---|---|
| `refraction-strength` | `1.0` | **Master switch + amplitude.** `0` turns the whole glass effect off. Strength = `clamp(value × 0.05, 0, 1)`, multiplied by half the shorter side to give the peak rim displacement **A** (px) — so the value saturates at `20`. |
| `edge-thickness` | `0.15` | Refraction band **H** = `value × half the shorter side` (px). Thicker reaches further into the window. |
| `physical-refraction` | `0` | Refraction model. **`0` = kwin / AndroidLiquidGlass path** (everything this fork changes lives here); `≥ 0.5` = HyprGlass path. |
| `corner-fan` | **`1.5`** | Corner arc radius of the direction field, as a multiple of that corner's real radius. `1.0` = plain rounded-rect SDF normal, which reads as an elbow at the corner; `1.5` equals Kyant0's `gradRadius = radius × 1.5`. Beyond 3 the corner folds back into a loop. |
| `depth-effect` | **`1.0`** | Kyant0's `depthEffect`: blends the inward radial into the edge normal so the **whole edge** leans toward the corner, not just inside the corner fan. `0` disables it. |
| `lens-distortion` | `0.0` | Centre dome lens — turns the whole window into a magnifier. `0` keeps edge refraction only. |
| `edge-padding` | **`-1` (auto)** | Fraction the sampling region is grown by, `padding(px) = value × window short side`. **Only takes effect when `xray false`** (the xray path samples the whole screen and neither needs nor uses padding).<br>`-1` (default) = **auto**, derived as `refraction-strength × 0.025 × 1.2` so it always covers the maximum displacement and scales with window size — normally **you never set this**.<br>`0` = off. `> 0` = manual override; must be a decimal (`12` means 12× the short side). |

#### Look (colour and highlight)

| Parameter | Default | Effect |
|---|---|---|
| `fringing` | `0.3` | Seven-tap spectral dispersion (Kyant0's chromaticAberration) — RGB colour fringes at the edge. |
| `glow-weight` | `0.08` | Border highlight strength. |
| `edge-lighting` | `1.0` | Edge light: lets the wallpaper's colour bleed into the window edge. |
| `power-factor` | `3.0` | Normal exponent — how soft or hard the edge transition is. Applies to both models. |
| `refraction-power` | `0.6` | Displacement / bevel strength, **HyprGlass path only (`physical-refraction ≥ 0.5`)**. |
| `brightness` | `1.0` | Brightness. |
| `contrast` | `1.0` | Contrast. |
| `saturation` | `0.85` | Saturation. |
| `vibrancy` | `0.12` | Vibrancy — the greyer the backdrop, the more it lifts. |
| `adaptive-dim` | `0.0` | Adaptive dim based on the sampled region's luminance. |
| `adaptive-boost` | `0.0` | Adaptive boost based on the sampled region's luminance. |

#### Deprecated

`refraction-a` / `refraction-b` / `refraction-c` / `refraction-d` / `glow-bias` / `glow-edge0` / `glow-edge1`
are HyprGlass-era parameters with **no remaining reference in the shader** — they are parsed for backwards compatibility only. Do not set them.

#### Model priority

`glass_effect()` picks a path in this order; the first match wins:

1. `refraction-strength == 0` → no refraction at all
2. `refraction-dilute > 0` → "dilute" mode (a standalone implementation that **bypasses the two below, so `corner-fan` / `depth-effect` stop applying**)
3. `physical-refraction < 0.5` → **kwin / AndroidLiquidGlass** (this fork's changes)
4. otherwise → HyprGlass

#### About xray

`xray` under `background-effect` decides where the glass reads background pixels from. The two paths are mutually exclusive:

| | `xray true` | `xray false` |
|---|---|---|
| Implementation | `Xray` (`src/render_helpers/xray.rs`) | `FramebufferEffect` (`framebuffer_effect.rs`) |
| Sampling source | A separately rendered **full-screen background buffer** | A blit capture of the screen at the element's own position |
| Can read pixels outside the window | Yes | **No** |

The refraction displacement points **outward past the window edge** (the `glassInwardNormal` edge normal points outside), so:

- `xray true` → outside pixels exist; edges look correct. **Recommended for ordinary windows.**
- `xray false` → the sampling source has no pixels beyond the window; out-of-range samples clamp and the edge pixels get smeared sideways — that is the **"edge artifacts / streaking"**.

To turn xray off (e.g. for layer surfaces, which have nothing meaningful "behind" them) the capture region must be grown, or streaking remains. **This is automatic** — the default `edge-padding -1` derives it for you:

```kdl
// auto (default, edge-padding -1):
//   A(px)       = refraction-strength × 0.025 × short_side   (max displacement is at the window edge, u = 0)
//   padding(px) = value × short_side
//   ⇒ value = refraction-strength × 0.025 × 1.2   (20% margin)
```

Set a positive number to override manually (fraction of the short side). The bare floor, if you want to compute it yourself:

| `refraction-strength` | 2 | 3 | 4 | 5 | 6 | 8 | 10 |
|---|---|---|---|---|---|---|---|
| minimum `edge-padding` | 0.05 | 0.075 | 0.10 | 0.125 | 0.15 | 0.20 | 0.25 |

Note `edge-padding` caps at 400 and is a **fraction of the short side**, not pixels, so one config scales with window size automatically.

> ⚠️ Auto padding relies on the `windowSize` fix in `main()` of `clipped_surface.frag`.
> Without it, the SDF / corner radius / bounds mask wrongly use the **expanded** `geo_size`,
> which visually shrinks the glass by roughly `1 - short_side/(short_side + 2×padding)` —
> clearly visible as an inset ring on `xray false` layer surfaces.

### Parameters for a frosted glass look

```kdl
saturation 0.9
vibrancy 0.2
adaptive-dim 0.25
adaptive-boost 0.25
```

Raising `saturation` / `vibrancy` and turning on both adaptive terms keeps the
backdrop readable but softens the rim, so the glass reads as frosted rather than
polished. Setting every parameter to `0` (except `saturation 1`) removes the effect
entirely — useful as a baseline when tuning.

### Notes on individual parameters

- `fringing` separates the RGB channels along the refraction direction (see
  [Seven-tap spectral dispersion](#seven-tap-spectral-dispersion--fringing)).
  `0` removes the colour edge completely.
- `edge-lighting` lets the wallpaper's colours bleed into the window edge, so the
  rim picks up the local palette instead of staying neutral.
- `glow-weight` is the rim highlight itself; `0` leaves the refraction intact but
  removes the bright border, which is the quickest way to tell the two apart.

## Warnings
- Tested in the 26.04 version
- newer versions may conflict with this.
- Vibe coded project so expect weirdly behavior.
