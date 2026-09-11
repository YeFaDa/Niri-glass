use std::sync::{Arc, Mutex};

use niri_config::CornerRadius;
use smithay::backend::renderer::gles::GlesRenderer;
use smithay::utils::{Logical, Point, Rectangle, Scale};
use smithay::wayland::compositor::{with_states, SurfaceData};
use wayland_server::protocol::wl_surface::WlSurface;

use crate::handlers::background_effect::get_cached_blur_region;
use crate::niri_render_elements;
use crate::render_helpers::blur::BlurOptions;
use crate::render_helpers::damage::ExtraDamage;
use crate::render_helpers::framebuffer_effect::{FramebufferEffect, FramebufferEffectElement};
use crate::render_helpers::liquid_glass::LiquidGlassOptions;
use crate::render_helpers::xray::{XrayElement, XrayPos};
use crate::render_helpers::RenderCtx;
use crate::utils::region::TransformedRegion;
use crate::utils::surface_geo;

#[derive(Debug)]
pub struct BackgroundEffect {
    nonxray: FramebufferEffect,
    /// Damage when options change.
    damage: ExtraDamage,
    /// Corner radius for clipping.
    ///
    /// Stored here in addition to `RenderParams` to damage when it changes.
    // FIXME: would be good to remove this duplication of radius.
    corner_radius: CornerRadius,
    blur_config: niri_config::Blur,
    options: Options,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Options {
    pub blur: bool,
    pub xray: bool,
    pub noise: Option<f64>,
    pub saturation: Option<f64>,
    pub liquid_glass: Option<LiquidGlassOptions>,
}

impl Options {
    fn is_visible(&self) -> bool {
        self.xray
            || self.blur
            || self.noise.is_some_and(|x| x > 0.)
            || self.saturation.is_some_and(|x| x != 1.)
            || self.liquid_glass.is_some()
    }
}

/// Render-time parameters.
#[derive(Debug)]
pub struct RenderParams {
    /// Geometry of the background effect (may be expanded by edge_padding).
    pub geometry: Rectangle<f64, Logical>,
    /// Original window geometry before expansion (used by xray shader for SDF).
    pub original_geometry: Rectangle<f64, Logical>,
    /// The effect geometry *before* the edge_padding expansion.
    ///
    /// This is the reference rectangle the shader must use: `geo_size` and
    /// `input_to_geo` describe the window/surface in *unexpanded* coordinates,
    /// and the shader applies no padding compensation of its own. Callers that
    /// need a clip rectangle when `clip` is `None` (layers and popups pass
    /// `clip_to_geometry = false`) must fall back to this, not to `geometry`,
    /// or `geo_size` silently becomes the padded size and the glass is drawn
    /// against the wrong rectangle.
    pub unpadded_geometry: Rectangle<f64, Logical>,
    /// Effect subregion, will be clipped to `geometry`.
    ///
    /// `subregion.iter()` should return `geometry`-relative rectangles.
    pub subregion: Option<TransformedRegion>,
    /// Geometry and radius for clipping in the same coordinate space as `geometry`.
    pub clip: Option<(Rectangle<f64, Logical>, CornerRadius)>,
    /// Scale to use for rounding to physical pixels.
    pub scale: f64,
}

impl RenderParams {
    fn fit_clip_radius(&mut self) {
        if let Some((geo, radius)) = &mut self.clip {
            // HACK: increase radius to avoid slight bleed on rounded corners.
            *radius = radius.expanded_by(1.);

            *radius = radius.fit_to(geo.size.w as f32, geo.size.h as f32);
        }
    }
}

niri_render_elements! {
    BackgroundEffectElement => {
        FramebufferEffect = FramebufferEffectElement,
        Xray = XrayElement,
        ExtraDamage = ExtraDamage,
    }
}

impl BackgroundEffect {
    pub fn new() -> Self {
        Self {
            nonxray: FramebufferEffect::new(),
            damage: ExtraDamage::new(),
            corner_radius: CornerRadius::default(),
            blur_config: niri_config::Blur::default(),
            options: Options::default(),
        }
    }

    /// Damage the background effect, for example when a blur subregion changes.
    pub fn damage(&mut self) {
        self.damage.damage_all();
        self.nonxray.damage();
    }

    pub fn update_config(&mut self, config: niri_config::Blur) {
        if self.blur_config == config {
            return;
        }

        self.blur_config = config;
        self.damage.damage_all();
        self.nonxray.damage();
    }

    pub fn update_render_elements(
        &mut self,
        corner_radius: CornerRadius,
        effect: niri_config::BackgroundEffect,
        has_blur_region: bool,
    ) {
        // If the surface explicitly requests a blur region, default blur to true.
        let blur = if has_blur_region {
            effect.blur != Some(false)
        } else {
            effect.blur == Some(true)
        };

        let liquid_glass = effect.liquid_glass.map(LiquidGlassOptions::from);

        if liquid_glass.is_some() {
        }

        let mut options = Options {
            blur,
            xray: effect.xray == Some(true),
            noise: effect.noise,
            saturation: effect.saturation,
            liquid_glass,
        };

        // If we have some background effect but xray wasn't explicitly set, default it to true
        // since it's cheaper.
        if options.is_visible() && effect.xray.is_none() {
            options.xray = true;
        }

        if self.options == options && self.corner_radius == corner_radius {
            return;
        }

        self.options = options;
        self.corner_radius = corner_radius;
        self.damage.damage_all();
        self.nonxray.damage();
    }

    pub fn is_visible(&self) -> bool {
        self.options.is_visible()
    }

    pub fn render(
        &self,
        ctx: RenderCtx<GlesRenderer>,
        ns: Option<usize>,
        mut params: RenderParams,
        xray_pos: XrayPos,
        padding_pixels: f32,
        push: &mut dyn FnMut(BackgroundEffectElement),
    ) {
        if !self.is_visible() {
            return;
        }

        if let Some(clip) = &mut params.clip {
            clip.1 = self.corner_radius;
        }
        params.fit_clip_radius();

        let damage = self.damage.render(params.geometry);

        let blur = self.options.blur && !self.blur_config.off;
        let blur_options = blur.then_some(BlurOptions::from(self.blur_config));
        let noise = if blur { self.blur_config.noise } else { 0. };
        let noise = self.options.noise.unwrap_or(noise) as f32;
        let saturation = if blur {
            self.blur_config.saturation
        } else {
            1.
        };
        let saturation = self.options.saturation.unwrap_or(saturation) as f32;

        if self.options.xray {
            let Some(xray) = ctx.xray else {
                return;
            };

            // Xray doesn't need expanded geometry — it samples from the scene-wide
            // background buffer. Use original window geometry for correct SDF.
            // Undo the xray_pos offset that render_for_tile added for expanded geometry.
            let expansion_offset = params.geometry.loc - params.original_geometry.loc;
            let xray_xray_pos = xray_pos.offset(Point::new(-expansion_offset.x, -expansion_offset.y));
            params.geometry = params.original_geometry;

            push(damage.into());
            xray.render(
                ctx,
                params,
                xray_xray_pos,
                blur,
                noise,
                saturation,
                self.options.liquid_glass,
                0.0,
                &mut |elem| push(elem.into()),
            );
        } else {
            let elem = self
                .nonxray
                .render(ns, params, blur_options, noise, saturation, self.options.liquid_glass, padding_pixels);
            push(elem.into());
        }
    }
}

fn render_params_for_tile(
    geometry: Rectangle<f64, Logical>,
    scale: f64,
    clip_to_geometry: bool,
    block_out: bool,
    blur_region: Option<Arc<Vec<Rectangle<i32, Logical>>>>,
    surface_geo: Rectangle<f64, Logical>,
    surface_anim_scale: Scale<f64>,
    padding: f64,
) -> Option<RenderParams> {
    // Effects not requested by the surface itself are drawn to match the geometry.
    let mut clip = true;

    let mut effect_geometry = geometry;

    let mut subregion = None;
    if let Some(rects) = blur_region {
        if rects.is_empty() {
            // Surface has a set, but empty blur region.
            return None;
        } else {
            // If the surface itself requests the effects, apply different defaults.
            clip = clip_to_geometry;

            // Use geometry-shaped blur for blocked-out windows to avoid unintentionally
            // leaking any surface shapes. We render those windows as geometry-shaped solid
            // rectangles anyway.
            if block_out {
                clip = true;
            } else {
                let mut surface_geo = surface_geo.upscale(surface_anim_scale);
                surface_geo.loc += geometry.loc;

                subregion = Some(TransformedRegion {
                    rects,
                    scale: surface_anim_scale,
                    offset: surface_geo.loc,
                });

                surface_geo = surface_geo
                    .to_physical_precise_round(scale)
                    .to_logical(scale);
                effect_geometry = surface_geo;
            }
        }
    }

    // Snapshot the unexpanded rectangle *after* the blur-region branch has had
    // its say -- this is the geometry the shader treats as the window.
    let unpadded_geometry = effect_geometry;

    // Now grow the *capture* region, so refraction has real pixels to sample
    // beyond the window/surface edge. Everything that describes the window
    // itself keeps using `unpadded_geometry` above.
    if padding > 0.0 {
        effect_geometry.loc.x -= padding;
        effect_geometry.loc.y -= padding;
        effect_geometry.size.w += padding * 2.0;
        effect_geometry.size.h += padding * 2.0;
    }

    // This corner radius is reset to self.corner_radius in render().
    let clip = clip.then_some((geometry, CornerRadius::default()));

    Some(RenderParams {
        geometry: effect_geometry,
        original_geometry: geometry,
        unpadded_geometry,
        subregion,
        clip,
        scale,
    })
}

/// Per-surface background effect stored in its data map.
struct SurfaceBackgroundEffect(Mutex<BackgroundEffect>);

impl SurfaceBackgroundEffect {
    fn get(states: &SurfaceData) -> &Self {
        states
            .data_map
            .get_or_insert(|| SurfaceBackgroundEffect(Mutex::new(BackgroundEffect::new())))
    }
}

pub fn damage_surface(states: &SurfaceData) {
    if let Some(effect) = states.data_map.get::<SurfaceBackgroundEffect>() {
        effect.0.lock().unwrap().damage();
    }
}

// Silence, Clippy
// A Smithay user is talking
#[allow(clippy::too_many_arguments)]
pub fn render_for_tile(
    ctx: RenderCtx<GlesRenderer>,
    ns: Option<usize>,
    geometry: Rectangle<f64, Logical>,
    scale: f64,
    clip_to_geometry: bool,
    surface: &WlSurface,
    surface_off: Point<f64, Logical>,
    surface_anim_scale: Scale<f64>,
    blur_config: niri_config::Blur,
    radius: CornerRadius,
    effect: niri_config::BackgroundEffect,
    should_block_out: bool,
    xray_pos: XrayPos,
    push: &mut dyn FnMut(BackgroundEffectElement),
) {
    with_states(surface, |states| {
        let background_effect = SurfaceBackgroundEffect::get(states);
        let mut background_effect = background_effect.0.lock().unwrap();

        let blur_region = get_cached_blur_region(states);
        let has_blur_region = blur_region.as_ref().is_some_and(|r| !r.is_empty());

        background_effect.update_config(blur_config);
        background_effect.update_render_elements(radius, effect, has_blur_region);

        if !background_effect.is_visible() {
            return;
        }

        let mut surface_geo = surface_geo(states).unwrap_or_default().to_f64();
        surface_geo.loc += surface_off;

        // Compute padding from liquid glass edge_padding.
        //
        // The xray path samples a full-screen buffer, so it can read pixels
        // outside the window and needs no padding — skip it there. The
        // framebuffer path can only see the element's own rect, so any
        // refraction displacement that reaches past the edge would clamp and
        // smear; it needs the capture region grown by at least the maximum
        // displacement.
        //
        // Max displacement (shader: `offsetPx = refractionStrength * minHalfSize * circle`,
        // which peaks at the window edge) is `strength * 0.025 * short_side` in
        // pixels once the 0.05 config scale is folded in, i.e. a fraction
        // `strength * 0.025` of the short side. Negative `edge_padding` means
        // auto: use exactly that, with 20% headroom. That makes the setting
        // size-independent and impossible to under-provision.
        let padding = match &background_effect.options.liquid_glass {
            Some(lg) if !background_effect.options.xray => {
                let min_dim = geometry.size.w.min(geometry.size.h);
                let frac = if lg.edge_padding < 0.0 {
                    (lg.refraction_strength.max(0.0) * 0.025 * 1.2).min(400.0)
                } else {
                    lg.edge_padding
                };
                frac * min_dim
            }
            _ => 0.0,
        };

        let Some(params) = render_params_for_tile(
            geometry,
            scale,
            clip_to_geometry,
            should_block_out,
            blur_region,
            surface_geo,
            surface_anim_scale,
            padding,
        ) else {
            return;
        };

        let xray_pos = xray_pos.offset(params.geometry.loc - geometry.loc);
        background_effect.render(ctx, ns, params, xray_pos, padding as f32, push);
    });
}
