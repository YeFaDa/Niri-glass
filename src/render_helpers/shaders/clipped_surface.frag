#version 100

//_DEFINES_

#if defined(EXTERNAL)
#extension GL_OES_EGL_image_external : require
#endif

precision highp float;
#if defined(EXTERNAL)
uniform samplerExternalOES tex;
#else
uniform sampler2D tex;
#endif

uniform float alpha;
varying vec2 v_coords;

#if defined(DEBUG_FLAGS)
uniform float tint;
#endif

uniform float niri_scale;

uniform vec2 geo_size;
uniform vec4 corner_radius;
uniform mat3 input_to_geo;

// Liquid glass uniforms
uniform float lg_refraction_strength;
uniform float lg_power_factor;
uniform float lg_refraction_a;
uniform float lg_refraction_b;
uniform float lg_refraction_c;
uniform float lg_refraction_d;
uniform float lg_refraction_power;
uniform float lg_glow_weight;
uniform float lg_glow_bias;
uniform float lg_glow_edge0;
uniform float lg_glow_edge1;
uniform float lg_edge_lighting;
uniform float lg_fringing;
// Refraction mode: 0.0 = kwin (SDF gradient, pode inverter em cantos)
//                  1.0 = HyprGlass (direção ao centro, nunca inverte)
uniform float lg_physical_refraction;
// Dilute refraction
uniform float lg_refraction_dilute;
uniform float lg_dilute_strength;
uniform float lg_dilute_fringing;
// HyprGlass-inspired uniforms
uniform float lg_lens_distortion;
uniform float lg_brightness;
uniform float lg_contrast;
uniform float lg_saturation;
uniform float lg_vibrancy;
uniform float lg_adaptive_dim;
uniform float lg_adaptive_boost;
uniform float lg_edge_thickness;
// Sampling-region expansion, in the same units as geo_size. Kept in the uniform
// list for the Rust plumbing, but intentionally NOT read here: padding only grows
// the capture region, and `input_to_geo` already yields window-space UVs. See the
// note in main().
uniform float lg_padding_pixels;
// Virtual corner round-over, as a multiple of the real corner radius.
// 1.0 = plain rounded-rect SDF normal; 1.5 = Kyant0's `gradRadius = radius * 1.5`.
uniform float lg_corner_fan;
// Kyant0 AndroidLiquidGlass `depthEffect` (0 = off, 1 = reference behaviour).
// Blends the inward radial into the edge normal so the refraction direction leans
// toward the corner along the whole edge, not just inside the corner fan.
uniform float lg_depth_effect;

float niri_rounding_alpha(vec2 coords, vec2 size, vec4 corner_radius);
vec4 postprocess(vec4 color);
vec2 refractionDir(vec2 uv);

// ============================================================================
// Liquid Glass effect -- faithful port of kwin-effects-glass
// https://github.com/4v3ngR/kwin-effects-glass
// ============================================================================

struct GlassFragment {
    vec4 color;
    float dist;
    float edgeFactor;
    float concaveFactor;
    vec3 normal;
    float ior;
};

// Rounded-rect SDF -- EXACT copy from kwin
// cornerRadius: x=bottom-left, y=bottom-right, z=top-left, w=top-right
float roundedRectangleDist(vec2 p, vec2 b, vec4 cornerRadius)
{
    float r = p.x > 0.0
        ? (p.y > 0.0 ? cornerRadius.y : cornerRadius.w)
        : (p.y > 0.0 ? cornerRadius.x : cornerRadius.z);
    vec2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

// Rounded rectangle for clipping -- from kwin
vec4 roundedRectangle(vec2 fragCoord, vec3 color, vec4 cornerRadius, vec2 blurSize)
{
    vec2 halfBlurSize = blurSize * 0.5;
    vec2 p = fragCoord - halfBlurSize;
    float dist = roundedRectangleDist(p, halfBlurSize, cornerRadius);

    if (dist <= 0.0) {
        return vec4(color, 1.0);
    }

    float s = smoothstep(0.0, 1.0, dist);
    return vec4(color, mix(1.0, 0.0, s));
}

// Per-corner radius -- same quadrant rule as roundedRectangleDist.
// cr: x=bottom-left, y=bottom-right, z=top-left, w=top-right
float cornerRadiusAt(vec2 p, vec4 cr)
{
    return p.x > 0.0 ? (p.y > 0.0 ? cr.y : cr.w) : (p.y > 0.0 ? cr.x : cr.z);
}

// Inward unit normal of the silhouette, with a *virtual* corner round-over.
//
// The plain SDF normal is exactly perpendicular to the edge along a whole
// straight run; it only turns inside the real corner arc (8-24px), so the turn
// reads as a kink. Pushing the corner arc centre out to `fan` spreads that turn
// into a fan. Kyant0 does exactly this, with `gradRadius = radius * 1.5`.
//
// Keep `fan` close to 1.5x the real radius. Widen it much further and the
// direction rotates so slowly over such a long stretch of edge that the mapping
// folds back on itself -- which shows up as a hook / loop in the content right
// at the corner.
vec2 glassInwardNormal(vec2 p, vec2 b, float fan)
{
    vec2 s = vec2(p.x >= 0.0 ? 1.0 : -1.0, p.y >= 0.0 ? 1.0 : -1.0);
    float r = clamp(fan, 1e-3, min(b.x, b.y));
    vec2 q = abs(p) - b + r;
    if (q.x > 0.0 && q.y > 0.0) {
        return normalize(s * (b - r) - p);   // radial, around the corner arc centre
    } else if (q.x > q.y) {
        return vec2(-s.x, 0.0);              // left / right edge
    }
    return vec2(0.0, -s.y);                  // top / bottom edge
}

// Refraction with two modes:
// physical_refraction 0.0 = kwin (SDF gradient, pushes outward)
// physical_refraction 1.0 = HyprGlass (center direction, pulls inward)
// uv_tex: global framebuffer UV, used only for texture sampling
// uv_min/uv_max: bounds da janela em espaço UV global
GlassFragment glassRefraction(vec2 uv_tex, vec2 uv_min, vec2 uv_max, vec2 position, vec2 halfBlurSize, vec4 cornerRadius, float dist, float edgeFactor, float concaveFactor, float refractionStrength, float refractionRGBFringing)
{
    // === Kyant0 / AndroidLiquidGlass refraction (ported) ===
    // H (band width, px)      = edge-thickness × minHalfSize     -- 不再受 30px 上限
    // A (rim displacement px) = refractionStrength × minHalfSize -- refractionStrength = config × 0.05
    // A/H = strength×0.05 / edge-thickness; ≥ 1.5 时边缘出现镜像回折 (Kyant0 demo 比例 = 2:1)
    // profile: d(u) = A × (1 - sqrt(1 - (1-u)^2)), u = δ/H   (circleMap)
    // 方向: 虚拟圆角法线（SDF 梯度的解析版 + 角部外扩）+ Kyant0 depthEffect 径向项
    float minHalfSize = min(halfBlurSize.x, halfBlurSize.y);
    float bandPx = max(minHalfSize * lg_edge_thickness, 8.0 * niri_scale);
    float edgeProximity = exp(dist / bandPx);

    // 窗口像素 -> 采集区 UV。input_to_geo 把 crop-UV 映射到 window-UV，其列向量的
    // 长度给出两个方向各自的缩放；用它归一后位移才是各向同性的。旧版直接用
    // geo_size，窗口越偏离正方形，位移方向越歪、幅度整体也偏大。
    vec2 uvScale = 1.0 / ((halfBlurSize * 2.0)
                          * vec2(length(input_to_geo[0].xy), length(input_to_geo[1].xy)));

    float depth = max(0.0, -dist);

    // 虚拟圆角半径 = corner-fan × 该角真实圆角半径（Kyant0 用 radius × 1.5）。
    // 距离剖面仍走真实轮廓，只有方向用这个放大的弧。
    float rAt = min(cornerRadiusAt(position, cornerRadius), minHalfSize);
    float fan = clamp(lg_corner_fan * rAt, rAt, minHalfSize);
    vec2 fanNormal = glassInwardNormal(position, halfBlurSize, fan);

    // Glass normal for outline/glow effects (kept from the old kwin path).
    // Deliberately the *geometric* normal: the depth term below is a non-physical
    // artistic tilt and must not steer the border highlight.
    vec2 normalXY = fanNormal * edgeProximity * refractionStrength * 0.5;
    vec3 glassNormal = normalize(vec3(normalXY, 1.0));

    // Kyant0 depthEffect -- `normalize(gradSd + normalize(centeredCoord))`.
    //
    // The plain edge normal is exactly perpendicular to the edge, so along a
    // straight edge the content only slides sideways and never leans toward the
    // corner: outside the corner fan the tangential share of the displacement is
    // a hard 0. Adding the *inward radial* rotates the direction progressively --
    // measured on a 900x600 window, the tangential share goes from ~0.43 mid-far
    // along the edge to ~0.12 at the other end -- which is the "wraps around the
    // corner" of the reference implementation.
    vec2 kwinNormal = fanNormal;
    if (abs(lg_depth_effect) > 1e-4) {
        float rl = length(position);
        if (rl > 1e-4) {
            kwinNormal = normalize(fanNormal - lg_depth_effect * (position / rl));
        }
    }

    float u = clamp(depth / bandPx, 0.0, 1.0);
    float circle = 1.0 - sqrt(max(0.0, 1.0 - (1.0 - u) * (1.0 - u)));
    float offsetPx = refractionStrength * minHalfSize * circle;

    vec4 color = vec4(0.0);
    if (offsetPx < 0.5) {
        // 带外：原样采样
        color = texture2D(tex, clamp(uv_tex, uv_min, uv_max));
    } else {
        vec2 baseOffset = kwinNormal * (offsetPx * uvScale);
        baseOffset.y = -baseOffset.y;

        // Kyant0 七点光谱色散 (chromaticAberration)：以折射后坐标为中心 ±disp
        if (lg_fringing > 0.001) {
            vec2 refracted = uv_tex + baseOffset;
            vec2 disp = baseOffset * lg_fringing;
            vec4 red    = texture2D(tex, clamp(refracted + disp,               uv_min, uv_max));
            vec4 orange = texture2D(tex, clamp(refracted + disp * (2.0 / 3.0), uv_min, uv_max));
            vec4 yellow = texture2D(tex, clamp(refracted + disp * (1.0 / 3.0), uv_min, uv_max));
            vec4 green  = texture2D(tex, clamp(refracted,                      uv_min, uv_max));
            vec4 cyan   = texture2D(tex, clamp(refracted - disp * (1.0 / 3.0), uv_min, uv_max));
            vec4 blue   = texture2D(tex, clamp(refracted - disp * (2.0 / 3.0), uv_min, uv_max));
            vec4 purple = texture2D(tex, clamp(refracted - disp,               uv_min, uv_max));
            color.r = red.r    / 3.5 + orange.r / 3.5 + yellow.r / 3.5 + purple.r / 7.0;
            color.g = orange.g / 7.0 + yellow.g / 3.5 + green.g  / 3.5 + cyan.g   / 3.5;
            color.b = cyan.b   / 3.0 + blue.b   / 3.0 + purple.b / 3.0;
            color.a = (red.a + orange.a + yellow.a + green.a + cyan.a + blue.a + purple.a) / 7.0;
        } else {
            color = texture2D(tex, clamp(uv_tex + baseOffset, uv_min, uv_max));
        }
    }

    return GlassFragment(color, dist, edgeFactor, concaveFactor, glassNormal, 1.0);
}

// Snell's law refraction -- HyprGlass-style direction with IOR magnitude
GlassFragment snellsRefraction(vec2 uv_tex, vec2 uv_min, vec2 uv_max, vec2 position, vec2 halfBlurSize, vec4 cornerRadius, float minHalfSize, float dist, float edgeFactor, float concaveFactor, float refractionStrength, float refractionBevelIntensity, float refractionOffsetStrength, float refractionRGBFringing)
{
    vec2 inwardDir = refractionDir(uv_tex);
    float bezelWidthPx = max(minHalfSize * lg_edge_thickness, 8.0 * niri_scale);
    float edgeProximity = exp(dist / bezelWidthPx);
    float bandWidth = max(minHalfSize * lg_edge_thickness, 4.0);
    float ior = 1.0 + refractionStrength * 0.5 * (lg_edge_thickness / 0.15);
    float lensMagnitude = concaveFactor * bandWidth * refractionBevelIntensity;
    float refractionMagnitude = lensMagnitude * refractionStrength;
    float maxOffsetPx = minHalfSize * 0.15;
    refractionMagnitude = min(refractionMagnitude, maxOffsetPx);
    vec2 uvScale = 1.0 / (halfBlurSize * 2.0);
    vec2 baseOffset = inwardDir * refractionMagnitude * uvScale;

    // Fix Y-axis: position space has Y inverted relative to UV space.
    baseOffset.y = -baseOffset.y;
    float eps = min(bandWidth * 0.75, min(min(cornerRadius.x, cornerRadius.y), min(cornerRadius.z, cornerRadius.w)) * 0.6);
    float dxp = roundedRectangleDist(position + vec2(eps, 0.0), halfBlurSize, cornerRadius);
    float dxn = roundedRectangleDist(position - vec2(eps, 0.0), halfBlurSize, cornerRadius);
    float dyp = roundedRectangleDist(position + vec2(0.0, eps), halfBlurSize, cornerRadius);
    float dyn = roundedRectangleDist(position - vec2(0.0, eps), halfBlurSize, cornerRadius);
    vec2 smoothGrad = vec2(dxp - dxn, dyp - dyn);
    float gradLen = length(smoothGrad);
    vec2 normalXY = gradLen > 0.001 ? (smoothGrad / gradLen) * concaveFactor * refractionBevelIntensity : vec2(0.0);
    vec3 glassNormal = normalize(vec3(normalXY, 1.0));
    float fringe = clamp(refractionRGBFringing, 0.0, 1.0) * 0.3;
    vec4 color = vec4(0.0);
    for (int i = 0; i < 3; i++) {
        float t = (float(i) + 1.0) / 3.0;
        vec2 sG = clamp(uv_tex + baseOffset * t, uv_min, uv_max);
        color.g += texture2D(tex, sG).g;
        color.a += texture2D(tex, sG).a;
        if (fringe > 0.001 && edgeProximity > 0.01) {
            vec2 sR = clamp(uv_tex + baseOffset * t * (1.0 + fringe), uv_min, uv_max);
            vec2 sB = clamp(uv_tex + baseOffset * t * (1.0 - fringe), uv_min, uv_max);
            color.r += texture2D(tex, sR).r;
            color.b += texture2D(tex, sB).b;
        } else {
            color.r += texture2D(tex, sG).r;
            color.b += texture2D(tex, sG).b;
        }
    }
    color /= 3.0;
    return GlassFragment(color, dist, edgeFactor, concaveFactor, glassNormal, ior);
}

// Dilute refraction
GlassFragment diluteRefraction(vec2 uv_tex, vec2 uv_min, vec2 uv_max, vec2 position, vec2 halfBlurSize, float dist, float edgeFactor, float concaveFactor, float refractionStrength, float refractionRGBFringing, float intensity)
{
    vec2 toCenter = -position;
    float lenToCenter = length(toCenter);
    vec2 dirIn = lenToCenter > 0.001 ? toCenter / lenToCenter : vec2(0.0);
    float minHalfSize = min(halfBlurSize.x, halfBlurSize.y);
    float maxOffsetPixels = minHalfSize * 0.06 * intensity;
    float magnitudePixels = concaveFactor * clamp(refractionStrength, 0.0, 1.0) * maxOffsetPixels;
    vec2 uvScale = 1.0 / (halfBlurSize * 2.0);
    vec2 offset = dirIn * magnitudePixels * uvScale;

    // Fix Y-axis: position space has Y inverted relative to UV space.
    offset.y = -offset.y;
    vec2 c0 = clamp(uv_tex + offset * 0.25, uv_min, uv_max);
    vec2 c1 = clamp(uv_tex + offset * 0.50, uv_min, uv_max);
    vec2 c2 = clamp(uv_tex + offset * 0.75, uv_min, uv_max);
    vec2 c3 = clamp(uv_tex + offset * 1.00, uv_min, uv_max);
    vec4 avg = (texture2D(tex, c0) + texture2D(tex, c1) + texture2D(tex, c2) + texture2D(tex, c3)) * 0.25;
    vec4 color;
    if (refractionRGBFringing > 0.001) {
        float fringe = clamp(refractionRGBFringing, 0.0, 1.0) * 0.3;
        vec2 coordR = clamp(uv_tex + offset * (1.0 + fringe), uv_min, uv_max);
        vec2 coordB = clamp(uv_tex + offset * (1.0 - fringe), uv_min, uv_max);
        color = vec4(texture2D(tex, coordR).r, avg.g, texture2D(tex, coordB).b, avg.a);
    } else {
        color = avg;
    }
    return GlassFragment(color, dist, edgeFactor, concaveFactor, vec3(0.0, 0.0, 1.0), 1.0);
}

// HyprGlass-inspired: refraction direction toward center
vec2 refractionDir(vec2 uv) {
    vec2 toCenterPx = (vec2(0.5) - uv) * geo_size;
    float len = length(toCenterPx);
    return len > 0.1 ? toCenterPx / len : vec2(0.0);
}

// HyprGlass-inspired: Center dome lens distortion
vec2 applyDomeLens(vec2 uv, float lensDistortion, float edgeProximity) {
    if (lensDistortion < 0.001) {
        return vec2(0.0, 0.0);
    }

    vec2 c = (uv - 0.5) * 2.0;
    vec2 dGrad = vec2(
        -4.0 * c.x * (1.0 - c.y * c.y),
        -4.0 * c.y * (1.0 - c.x * c.x)
    );

    float minDim = min(geo_size.x, geo_size.y);
    float lensMaxPx = lensDistortion * minDim * 0.06;
    float lensFade = 1.0 - edgeProximity;

    return dGrad * lensMaxPx * lensFade / geo_size;
}

// HyprGlass-inspired: Frosted tint with adaptive luminance
// Based on Hyprland's blurFinish.glsl (brightness + noise) + blur1.glsl (vibrancy in HSL)
vec3 applyFrostedTint(vec3 color, float edgeProximity) {
    // 1. Saturation (desaturate then mix back)
    float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = clamp(mix(vec3(lum), color, lg_saturation), 0.0, 1.0);

    // 2. Brightness (like Hyprland: simple multiply, clamped)
    color *= clamp(lg_brightness, 0.0, 1.0);

    // 3. Adaptive dim: darken bright areas proportionally to luminance
    //    Uses smoothstep so low-lum areas are unaffected
    if (lg_adaptive_dim > 0.001) {
        float dimFactor = smoothstep(0.3, 0.8, lum);
        color *= 1.0 - lg_adaptive_dim * dimFactor;
    }

    // 4. Adaptive boost: lighten dark areas
    //    Additive, but capped and blended with edge proximity
    if (lg_adaptive_boost > 0.001) {
        float boostFactor = 1.0 - smoothstep(0.0, 0.5, lum);
        color += vec3(lg_adaptive_boost * boostFactor * 0.15);
    }

    color = clamp(color, 0.0, 1.0);

    // 5. Contrast (mix toward mid-gray)
    color = clamp(mix(vec3(0.5), color, lg_contrast), 0.0, 1.0);

    // 6. Vibrancy (boost saturated colors, like Hyprland's HSL approach)
    if (lg_vibrancy > 0.001) {
        float currentLum = dot(color, vec3(0.2126, 0.7152, 0.0722));
        float sat = max(color.r, max(color.g, color.b)) - min(color.r, min(color.g, color.b));
        color = clamp(mix(vec3(currentLum), color, 1.0 + lg_vibrancy * sat), 0.0, 1.0);
    }

    return color;
}

// Outline -- kwin-style with HyprGlass specular
vec3 glassOutline(vec2 position, vec2 blurSize, GlassFragment s, float glowStrength, float edgeLighting, float edgeProximity)
{
    float rimMask = clamp(0.25 * s.concaveFactor, 0.0, glowStrength);
    // 内容色高光：边框光取折射内容色（绕亮度轴提饱和 ×2、提亮 ×1.3、5% 抬底），替代纯白
    // 暗内容下光也随之变暗——这是"反射内部颜色"的物理行为
    vec3 cc = s.color.rgb;
    float cLum = dot(cc, vec3(0.299, 0.587, 0.114));
    vec3 contentLight = clamp(mix(vec3(cLum), cc, 2.0) * 1.3 + vec3(0.05), 0.0, 1.0);
    vec3 glow = mix(s.color.rgb, contentLight, rimMask);
    if (edgeLighting > 0.001) {
        glow += (s.color.rgb * s.concaveFactor) * edgeLighting;
    }

    if (glowStrength > 0.0) {
        float edgeMask = smoothstep(0.0, -2.0, s.dist);
        float borderInner = smoothstep(-1.0, -3.0, s.dist);
        float edgeProfile = edgeMask - borderInner;
        float thicknessShadow = pow(edgeProfile, 0.9);
        float shadowMask = smoothstep(blurSize.y * 0.7, -blurSize.y * 0.7, position.y) *
                           smoothstep(blurSize.x * 0.7, -blurSize.x * 0.7, position.x);
        float highlightMask = smoothstep(-blurSize.y * 0.7, blurSize.y * 0.7, position.y) *
                              smoothstep(-blurSize.x * 0.7, blurSize.x * 0.7, position.x);

        glow = mix(glow, contentLight, thicknessShadow * shadowMask);
        glow = mix(glow, contentLight, thicknessShadow * highlightMask);
    }

    // HyprGlass-style Fresnel
    if (glowStrength > 0.001) {
        float fresnel = edgeProximity * edgeProximity * glowStrength * 0.15;
        glow += contentLight * fresnel;
    }

    // HyprGlass-style specular (top-biased)
    if (glowStrength > 0.001) {
        float topBias = pow(max(1.0 - (position.y / blurSize.y + 0.5), 0.0), 2.0);
        float spec = topBias * edgeProximity * edgeProximity * glowStrength * 0.08;
        glow += contentLight * spec;
    }

    // HyprGlass-style inner shadow (bottom rim)
    {
        float bottomBias = pow(position.y / blurSize.y + 0.5, 2.0);
        float shadow = bottomBias * edgeProximity * edgeProximity * 0.06;
        glow *= 1.0 - shadow;
    }

    return glow;
}

// Main glass function -- faithful port of kwin's glass()
//
// FIX: separação de dois espaços UV:
//   uv_tex  = v_coords   → coordenadas no framebuffer global (0..1 da tela inteira)
//                           usado APENAS para amostrar a textura
//   uv_geo  = coords_geo → coordenadas normalizadas DENTRO da janela (0..1)
//                           usado para calcular a posição no SDF e o clip final
//
// O bug original: passava-se apenas v_coords para ambos os propósitos.
// Quando a janela não começa na origem do framebuffer, v_coords não vai de
// 0 a 1 dentro da janela, então o position ficava offset e o SDF só
// detectava borda num lado (tipicamente o esquerdo).
//
// FIX2: glowStrength não é mais multiplicado por 10.0 — o valor lg_glow_weight
//        (0..1) é passado diretamente para evitar saturação total do glow.
// FIX3: edgeLighting agora é controlado pelo uniform lg_edge_lighting em vez
//        de ser hardcoded em 1.0.
// FIX4: refractionRGBFringing agora é controlado pelo uniform lg_fringing em
//        vez de ser hardcoded em 0.3.
vec4 glass_effect(vec2 uv_tex, vec2 windowUV, vec4 baseColor, vec2 blurSize, vec4 cornerRadius,
                  float refractionStrength, float refractionNormalPow,
                  float refractionRGBFringing, float refractionOffsetStrength,
                  float refractionBevelIntensity, float physicallyBasedRefraction,
                  float glowStrength, float edgeLighting)
{
    vec2 halfBlurSize = blurSize * 0.5;
    float minHalfSize = min(halfBlurSize.x, halfBlurSize.y);

    // Position in pixel coords relative to center (same as kwin)
    vec2 position = windowUV * blurSize - halfBlurSize.xy;
    position.y = -position.y; // Invert Y for kwin convention
    float dist = roundedRectangleDist(position, halfBlurSize, cornerRadius);

    // Outside rectangle = no effect
    if (dist >= 0.0) {
        return baseColor;
    }

    // Clamp to screen bounds (like kwin original — allows content beyond window)
    vec2 uv_min = vec2(0.0);
    vec2 uv_max = vec2(1.0);

    // Edge and concave factors
    // FIX: minEsp limitado a 30px máximo
    float minEsp = clamp(minHalfSize * 0.15, 0.1, min(minHalfSize * 0.9, 30.0));
    float edgeFactor = 1.0 - clamp(abs(dist) / minEsp, 0.0, 1.0);
    float smoothEdge = smoothstep(0.0, 1.0, edgeFactor);
    float concaveFactor = 1.0 - sqrt(max(0.0, 1.0 - pow(smoothEdge, refractionNormalPow)));

    // HyprGlass-style exponential edge proximity
    float bezelWidthPx = max(minHalfSize * lg_edge_thickness, 8.0 * niri_scale);
    float edgeProximity = exp(dist / bezelWidthPx);

    GlassFragment s;
    if (refractionStrength > 0.0) {
        if (lg_refraction_dilute > 0.0001) {
            // Dilute mode: independent, ignores kwin/HyprGlass
            float diluteSt = lg_dilute_strength > 0.0
                ? clamp(lg_dilute_strength * 0.05, 0.0, 1.0)
                : clamp(lg_refraction_dilute * 0.15, 0.0, 1.0);
            float diluteIntensity = max(lg_refraction_dilute, 1.0);
            s = diluteRefraction(uv_tex, uv_min, uv_max, position, halfBlurSize, dist, edgeFactor, concaveFactor, diluteSt, lg_dilute_fringing, diluteIntensity);
        } else if (physicallyBasedRefraction < 0.5) {
            // Kwin mode -- real silhouette radius: the *distance* profile must
            // start at the actual window edge, only the normal fans wider.
            s = glassRefraction(uv_tex, uv_min, uv_max, position, halfBlurSize, cornerRadius, dist, edgeFactor, concaveFactor, refractionStrength, refractionRGBFringing);
        } else {
            // HyprGlass mode
            vec4 r = clamp(cornerRadius * 2.0, min(64.0, minHalfSize), min(128.0, minHalfSize));
            s = snellsRefraction(uv_tex, uv_min, uv_max, position, halfBlurSize, r, minHalfSize, dist, edgeFactor, concaveFactor, refractionStrength, refractionBevelIntensity, refractionOffsetStrength, refractionRGBFringing);
        }
    } else {
        s = GlassFragment(baseColor, dist, edgeFactor, concaveFactor, vec3(0.0, 0.0, 1.0), 1.0);
    }

    // HyprGlass-style center dome lens
    vec2 domeUV = applyDomeLens(uv_tex, lg_lens_distortion, edgeProximity);
    if (length(domeUV) > 0.001) {
        vec2 maxOffPos = vec2(1.0) - uv_tex;
        vec2 maxOffNeg = uv_tex;
        domeUV = clamp(domeUV, -maxOffNeg, maxOffPos);
        s.color = texture2D(tex, uv_tex + domeUV);
    }

    // HyprGlass-style frosted tint
    s.color.rgb = applyFrostedTint(s.color.rgb, edgeProximity);

    // Apply outline (kwin + HyprGlass)
    vec3 rgb = s.concaveFactor < 1.0 ? glassOutline(position, blurSize, s, glowStrength, edgeLighting, edgeProximity) : s.color.rgb;

    // Não aplicamos roundedRectangle aqui: o clip de cantos arredondados já é
    // feito pelo niri_rounding_alpha no main(). Aplicar os dois causa uma linha
    // de artefato nos cantos porque os dois SDFs usam corner_radius em espaços
    // diferentes (kwin vs niri) e não se cancelam perfeitamente.
    return vec4(rgb, s.color.a);
}

void main() {
    vec3 coords_geo = input_to_geo * vec3(v_coords, 1.0);

    vec4 color = texture2D(tex, v_coords);
#if defined(NO_ALPHA)
    color = vec4(color.rgb, 1.0);
#endif

    // `input_to_geo` already maps v_coords into *window* space: `geo_size` is the
    // unexpanded window size (framebuffer_effect passes `clip_geo`, which is the
    // original geometry — never the padded capture region). So the UVs need no
    // compensation here, and `lg_padding_pixels` is deliberately unused in this
    // shader: padding only grows the *capture* region on the Rust side so that
    // refraction has real pixels to sample beyond the window edge. The band it
    // adds lands outside [0, 1] and is masked by `insideGeo` below.
    //
    // (Do not "fix" this by remapping windowUV against padding — an earlier
    // attempt did exactly that and both shrank the glass and offset the SDF.)
    vec2 windowUV = coords_geo.xy;

    // Binary mask — clip to window bounds
    float insideGeo = step(0.0, windowUV.x) * step(windowUV.x, 1.0)
                     * step(0.0, windowUV.y) * step(windowUV.y, 1.0);
    float lgEnabled = step(0.0001, lg_refraction_strength);
    float effectMask = insideGeo * lgEnabled;

    if (effectMask > 0.0) {
        // Normalize strength (config 0-100 -> shader 0-1)
        float normStrength = clamp(lg_refraction_strength * 0.05, 0.0, 1.0);

        // Remap corner radius: niri=[TL,TR,BR,BL] -> kwin=[BL,BR,TL,TR]
        vec4 cr = vec4(corner_radius.w, corner_radius.z, corner_radius.x, corner_radius.y);

        vec4 result = glass_effect(
            v_coords,       // uv_tex
            windowUV,       // window UV (0-1 within window)
            color, geo_size, cr,
            normStrength,
            lg_power_factor,           // refractionNormalPow
            lg_fringing,               // refractionRGBFringing
            lg_refraction_power,       // refractionOffsetStrength
            lg_refraction_power,       // refractionBevelIntensity
            lg_physical_refraction,
            lg_glow_weight,            // glowStrength
            lg_edge_lighting           // edgeLighting
        );
        color = result;
    }

    color = postprocess(color);

    color = color * niri_rounding_alpha(windowUV * geo_size, geo_size, corner_radius)
                  * insideGeo;

    color = color * alpha;

#if defined(DEBUG_FLAGS)
    if (tint == 1.0)
        color = vec4(0.0, 0.2, 0.0, 0.2) + color * 0.8;
#endif

    gl_FragColor = color;
}
