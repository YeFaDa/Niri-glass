# AGENTS.md

项目进度与约定。**不要在工作区创建 `.workbuddy/`。**

## 改动生效链路

源码由 `~/nixos-config` 从 `github:YeFaDa/Niri-glass` 的 **锁定 rev** 取,不是本地工作区。
只 commit 不够,必须走完:

1. `git commit` + `git push`
2. `cd ~/nixos-config && nix flake update niri-glass`
3. `nixos-rebuild switch`

判断"当前跑的 niri 是否含某改动"：`NIRI_CONFIG=<临时kdl> niri validate`
喂一个只有新代码才接受的值,报错即说明跑的还是旧 rev。

overlay 只覆盖 8 个文件（见 `~/nixos-config/software-configuration.nix`）：
`liquid_glass.rs` `background_effect.rs` `framebuffer_effect.rs` `xray.rs` `mod.rs`
`clipped_surface.frag` `shaders/mod.rs` `appearance.rs`。改其他文件不生效。

## 关键不变量

- `geo_size` 必须是**未扩展**的窗口/表面矩形。`clip` 为 `None` 时（layer / popup 传
  `clip_to_geometry = false`）必须回退到 `RenderParams::unpadded_geometry`,不能回退到
  `params.geometry`（那是扩展后的）。否则玻璃按错误矩形绘制。
- shader 里**不要**给 `windowUV` 加 padding 补偿。`input_to_geo` 已输出窗口 UV。
- `render_params_for_tile` 里 padding 扩展必须在 blur-region 分支**之后**。放前面会被
  `effect_geometry = surface_geo` 覆盖掉。

## 已知问题（非本项目）

- **关闭组件时闪一帧亮边框**：背景效果元素拿不到 alpha（`render_for_tile` 签名里没有），
  而 noctalia 的关闭动画是客户端自己画的,所以内容淡出时玻璃仍满强度渲染。
  修不了,除非关掉 noctalia 的关闭动画。
- `xray false` 边缘发亮：折射在边缘被 clamp 反复采样。用 `xray true` 规避。

## 文档

README（`README.md` / `README.zh-CN.md`）把「覆盖到你自己的 niri 上」作为**推荐用法**
（`prev.niri.overrideAttrs` + postPatch cp 那 8 个文件），并声明**仅在 niri 26.04 测试过**。
flake 自带的打包方式降级为备选方案。

## 方向场的 45° 折痕 = 角部对角线的真正来源（已修）

**结论（用户实测确认）**：角部那条线是**方向场跳变**造成的**颜色硬边**，
**不是**幅度上的折叠线（caustic）。判据不能看"位移多大"，要看**是否连续**。

`glassInwardNormal` 原本用硬分支挑最近边（`q.x > q.y`），在 **`q.x == q.y` 的 45° 中线**上
让方向**直接跳 90°**。该中线从**虚拟角弧圆心**（深度 = `fan`）往内延伸，落在折射带内。

**正确的量化方式（关键经验）**：测**采样偏移量的相邻差**，并看它**是否随采样步长变小**。

| 采样步长 | 现状 max\|Δ采样偏移\| | 平滑版 |
|---|---|---|
| 1.0px | 4.46px | 4.46px |
| 0.5px | 3.59px | 2.30px |
| 0.25px | **3.52px**（不降 → 真不连续） | **1.17px**（随步长线性降 → 连续） |

现状在 p=(817,474)、深度 36px（= fan）、位移只有 4.5px、**相邻法线夹角 90.0°**。
⇒ 位移小 ≠ 看不见：方向一跳，采样点**横跳 3.5px 且无过渡**，就是硬边。
（上一轮我按"位移只有 4.5px"判定它不是主因，**错了**。）

**修法**：`smoothstep` 平滑混合两个边法线（= 硬倒角的连续版；硬倒角只会把 1 个 90° 换成 2 个 45°），
再把角弧径向项在角方格内**淡入**——纯径向场绕自身圆心转满 360°，任何连续场都做不到，
所以圆心那点必须交给边法线混合场。

**等价性验证**：右上角 200×200px、0.5px 网格共 401×401 点，两条混合带**之外不一致点数 = 0**；
混合带内最大方向变化 45°（对角线上取中间值）。

**`corner-fan` 管不了它**：实测 fan 从 12 到 72，折痕始终 90°（只把起点外推）。

> 另有一条**独立**的幅度现象：折叠线 `d = u*·H`，判据 `d/r > 1`（`u*` 只由 `A/H` 决定）。
> 那是图像内容被压缩出来的线，用户明确说**不是**他报的问题；真要治只能夹带宽 `H_eff = min(H, k·r)`。

**判据**：跳变不随采样变细而变小；连续场才会递减。硬倒角只是把 90° 拆成两个 45°，仍是突变。

## 另两处同类跳变（2026-09-27 已修）

同一个判据找出来的，都属于「跳变产生的颜色硬边」。

### 1) 带尾的 `offsetPx < 0.5` 提前返回（`glassRefraction`）

旧代码：`offsetPx < 0.5` 时直接在 `uv_tex` 处采样（不偏移），
于是采样位置在深度 ≈ 0.9·带宽处从 **0.595px 硬切到 0** —— 一圈亚像素硬边。
实测跳变 0.595 / 0.542 / 0.516 / **0.504px**（步长 0.5→0.0625px，**不降 = 真跳变**）。

**改法**：两条路**共用同一个采样中心**，分支只决定要不要做七点色散：
判据从「偏移量」换成「**色散张开量** `offsetPx * lg_fringing`」，≤ 0.15px 时短路。
实测改为 0.134 / 0.068 / 0.034 / **0.017px**（随步长线性降 = 连续）。
且 `offsetPx == 0`（窗口内部，占绝大部分面积）时 `baseOffset == 0`，与旧行为逐点相同。

> ⚠️ **不能直接删掉这个分支**：fringing 开着时会让整个窗口内部都付 7 次采样。
> 「张开量」判据同时解决了连续性和这个开销。

### 2) `cornerRadiusAt` 的象限硬分支

旧代码用 `p.x > 0.0 ? ... : ...` 取角半径，`fan` 由它派生 →
**四角半径不同时**（如 `geometry-corner-radius 24 24 0 0`），
`fan` 在中线上直接跳，方向场跟着跳 —— 一条**从边直通窗口中心的长线**，
比角部折痕长得多。实测 `fan` 跳变 **36.000px**（步长 0.5→0.125px 恒定）。

**改法**：`smoothstep` 混合四个角半径（带宽 `4 * niri_scale`）。
实测 4.46 / 2.25 / 1.12 / **0.56px**（线性降 = 连续）。
四角半径相同时**逐点等价**（带外不一致点数 = 0，两种 cr 都一样）。

**只平滑 `fan`，`roundedRectangleDist` 保持硬取**：那里它定义的是真实轮廓本身；
而且它在中线上**与半径无关**（`sd = -b`），本来就是连续的。

**要治它只能夹带宽**：`H_eff = min(H, k·r)`，使 `d ≤ r`（`d = u*·H`，`u*` 只由 `A/H` 决定）。

## 边缘光按边分侧（2026-09-27）

`glassOutline` 里两束光改成按边分：`glow-weight` 只作用于**上下**边框，
`edge-lighting` 只作用于**左右**边框。

```glsl
vec2 halfBlurSize = blurSize * 0.5;
float sideBlend = max(2.0 * niri_scale, min(halfBlurSize.x, halfBlurSize.y) * 0.05);
float dTB = halfBlurSize.y - abs(position.y);      // 到上/下边的距离
float dLR = halfBlurSize.x - abs(position.x);      // 到左/右边的距离
float vertical = smoothstep(-sideBlend, sideBlend, dLR - dTB);   // 1 = 上下
float horizontal = 1.0 - vertical;
```

乘在哪：`rimMask`、厚度块的两次 `mix`、Fresnel、顶部镜面 → `* vertical`；
`edge-lighting` 那一项 → `* horizontal`。

**为什么用 smoothstep 而不是硬选边**：硬选会在角部 45° 换手线上让光强整档跳，
又是同一类颜色硬边。实测跨换手线的 `Δvertical` 随步长线性降
（1.0/0.5/0.25/0.125px → 0.0416/0.0208/0.0104/0.0052），连续。

实测（window-rule）：上/下边中点 `vertical=1.000`、左/右边中点 `horizontal=1.000`、
角部 45° 处各 0.500。`sideBlend`：窗口 25.5px、400×300 面板 7.5px、1200×48 的 bar 取地板 3px。

> 注意：底部内阴影（`bottomBias * edgeProximity² * 0.06`）**不受任何开关控制**，
> 本来就只在底边，本次未动。

## 构建与验证

- 本机**没有 cargo/rustc**,Rust 侧只能人工核对。
- GLSL：`nix shell nixpkgs#glslang -c glslangValidator <frag>`。
- 录像抽帧看单帧闪烁：`nix shell nixpkgs#ffmpeg`,逐帧亮度用
  `-vf 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=/tmp/y.txt'`
  （**别加 `-loglevel error`**,会把 metadata 一起压掉），再按帧号抽图。
