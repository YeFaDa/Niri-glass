# Liquid Glass Effect for Niri

**[English](README.md)** | **[中文](README.zh-CN.md)**

## Examples

1.

  <img width="1920" height="1080" alt="Screenshot from 2026-07-02 00-06-33" src="https://github.com/user-attachments/assets/a10b40c7-b147-4dfa-8208-28ebb4003cfc" />

1.

<img width="1920" height="1080" alt="Screenshot from 2026-06-30 12-31-50" src="https://github.com/user-attachments/assets/8cad6485-b685-4bc9-b22e-8cf7801cd15a" />

1.

<img width="1920" height="1080" alt="Screenshot from 2026-06-30 12-32-48" src="https://github.com/user-attachments/assets/fccc46f0-9cda-488b-b0e1-5939d36676cf" />

1.

<img width="1920" height="1080" alt="Screenshot from 2026-06-30 12-34-48" src="https://github.com/user-attachments/assets/ff3f0d17-3bf1-42e8-9660-e291189321f9" />

1.

<img width="1920" height="1080" alt="Screenshot from 2026-06-30 12-40-02" src="https://github.com/user-attachments/assets/eaeda5ef-1fe3-4e51-8466-10e461240021" />

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

### Nix / NixOS (flake)

This repo ships a flake that builds niri with the liquid-glass overlay applied
on top of the matching upstream niri release (pinned to rev `49fc611`, niri
26.04). No manual file copying or `install.sh` needed.

Quick try-out (no install):

```bash
nix run github:zaroutt/Niri-glass          # run the compositor
nix shell github:zaroutt/Niri-glass        # drop niri-glass into a shell
nix develop github:zaroutt/Niri-glass      # dev shell (rust + niri build deps)
nix build  github:zaroutt/Niri-glass       # build, result at ./result
```

NixOS (flake), reusing the upstream niri session/portal/polkit wiring:

```nix
{
  inputs.niri-glass.url = "github:zaroutt/Niri-glass";

  # in your nixosConfiguration modules:
  imports = [ inputs.niri-glass.nixosModules.default ];
  programs.niri-glass.enable = true;
}
```

home-manager:

```nix
{
  imports = [ inputs.niri-glass.homeManagerModules.default ];
  programs.niri-glass = {
    enable = true;
    # optional: manage ~/.config/niri/config.kdl
    config = builtins.readFile ./niri/config.kdl;
  };
}
```

Or just add the package via the overlay (`overlays.default` exposes
`pkgs.niri-glass`) or reference `inputs.niri-glass.packages.<system>.niri-glass`
directly anywhere a package is expected (e.g. `programs.niri.package`).

> The flake is pinned to the exact niri revision these overlay files were
> written against. If you bump the `niri` input, refresh the overlay files to
> match or the build may fail to compile.

### install.sh (non-Nix)

Clone the official repo and this one and run the install script:

```bash
git clone https://github.com/niri-wm/niri
git clone https://github.com/zaroutt/Niri-glass
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

<img width="462" height="276" alt="Screenshot from 2026-06-30 13-40-40" src="https://github.com/user-attachments/assets/ef2949f8-c8b7-4805-a2b5-7aaa87507525" />

With all parameters set to 0 (except saturation, which is set to 1):

<img width="462" height="276" alt="Screenshot from 2026-06-30 13-37-39" src="https://github.com/user-attachments/assets/991553ad-66d0-4a62-8519-8ce3b04bdcc0" /> ```

### others

- fringing:
  this make rgb colors appear

  <img width="243" height="63" alt="Screenshot from 2026-06-30 16-13-20" src="https://github.com/user-attachments/assets/56d589e5-ffa1-46e9-a58a-996d015070e9" />

- edge-lightning

  this make the wallpapers colors blend with the edges

<img width="533" height="320" alt="Screenshot from 2026-06-30 16-18-04" src="https://github.com/user-attachments/assets/91d4b152-8bec-47dc-b4dd-6f10a30a441d" />

<img width="531" height="329" alt="Screenshot from 2026-06-30 16-17-54" src="https://github.com/user-attachments/assets/c4ba4a55-a3cd-49b5-ae15-fdf9154650c4" />

## More examples

### Interaction with live wallpaper with shadows enabled

https://github.com/user-attachments/assets/4fceeaaf-4ff1-4c4d-adcf-af52cd33a912

### With xray set to false

<img width="1920" height="1080" alt="Screenshot from 2026-07-22 20-58-17" src="https://github.com/user-attachments/assets/049102f2-d7c9-4d0b-8862-671c34c61d18" />




## Warnings
- Tested in the 26.04 version
- newer versions may conflict with this.
- Vibe coded project so expect weirdly behavior.
  
