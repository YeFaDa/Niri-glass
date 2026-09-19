# Niri 液态玻璃

## 本 fork 增加的效果

本 fork 的所有改动都在 kwin / AndroidLiquidGlass 这条路上(`physical-refraction 0`)。
其中两个效果是从 Kyant0 的 AndroidLiquidGlass 移植过来的,默认都开着。

### 七点光谱色散 —— `fringing`

折射会对背景做**七次采样**,沿折射方向依次偏移:
红 → 橙 → 黄 → 绿 → 青 → 蓝 → 紫,再把通道混回去(`color.r` 取自红/橙/黄/紫,其余同理)。
结果是边缘出现彩色描边,且**位移最大处最明显** —— 也就是窗口最边缘那一圈。

| 值 | 看到什么 |
|---|---|
| `0` | 关闭 —— 单次采样,没有颜色分离 |
| `0.2` | 淡淡的彩边(推荐) |
| `0.4`+ | 采样点拉得太开,看起来像三张错位图,而不是色散 |

### 深度项 —— `depth-effect`

普通圆角矩形的 SDF **法线垂直于每条直边**,所以直边处的内容只会**横向平移**、
不会朝角部倾,转向全部挤在真实的圆角弧里,读起来就是一个折肘。

`depth-effect` 把**朝内的径向**混进法线:

```glsl
kwinNormal = normalize(fanNormal - depthEffect * normalize(position));
```

于是方向沿**整条边**渐进旋转,而不是只在角部才转。这就是 Kyant0 的 `depthEffect`,
也是直线看起来会"绕过角部"的原因。

| 值 | 看到什么 |
|---|---|
| `1` | 参考实现的行为 |
| `0` | 纯 SDF 法线 —— 角部读成一个折肘 |

配合 `corner-fan`(决定角弧**有多宽**),这两个效果共同决定了 kwin 路径的形状。

## 文件

### 着色器(Shader)

- `src/render_helpers/shaders/clipped_surface.frag` - 液态玻璃主效果着色器(基于 [kwin-effects-glass](https://github.com/4v3ngR/kwin-effects-glass))

### Rust(渲染)

- `src/render_helpers/liquid_glass.rs` - `LiquidGlassOptions` 结构体,定义效果参数
- `src/render_helpers/background_effect.rs` - 液态玻璃与背景效果的集成
- `src/render_helpers/framebuffer_effect.rs` - 着色器 uniform 传递(窗口)
- `src/render_helpers/xray.rs` - 着色器 uniform 传递(xray)
- `src/render_helpers/shaders/mod.rs` - 着色器编译时的 uniform 注册
- `src/render_helpers/mod.rs` - liquid_glass 模块声明

### Niri 配置

- `config.kdl` - 启用了液态玻璃的示例配置

## 如何使用

### Nix / NixOS —— 覆盖到你自己的 niri 上(推荐)

本仓库是一组零散源文件,不是一个必须从固定基线编译的 fork。推荐做法是把这些文件
覆盖到你**已有的 niri** 上,这样你自己的 nixpkgs、内核和 Rust 工具链都保持不变。

```nix
# flake.nix:加上这个 input
inputs.niri-glass.url = "github:YeFaDa/Niri-glass";
```

```nix
# 在你定义 nixpkgs overlays 的地方(比如某个配置模块里)
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

然后把 session 指向这个包:

```nix
programs.niri.package = pkgs.niri-glass;
```

> [!IMPORTANT]
> **兼容性:仅在 niri 26.04 测试过。** overlay 是整文件替换
> (`background_effect.rs`、`appearance.rs`、`clipped_surface.frag` 等),
> 所以必须用在**同一代**的 niri 上。其他版本可能编译失败或行为异常。
> overlay 不动 `Cargo.toml` / `Cargo.lock`,所以 vendor 的依赖集合完全不变,
> 只有 `niri` 这个 crate 会重新编译。

### Nix / NixOS(flake,帮你编译基线)

不想自己接 overlay 的话,仓库也带了 flake,基于固定基线
(rev `49fc611`,niri 26.04)加上 overlay 直接编译:

```bash
nix run github:YeFaDa/Niri-glass          # 跑合成器
nix shell github:YeFaDa/Niri-glass        # 把 niri-glass 加进 shell
nix develop github:YeFaDa/Niri-glass      # 开发 shell(rust + niri 编译依赖)
nix build  github:YeFaDa/Niri-glass       # 编译,产物在 ./result
```

`nixosModules.default` / `homeManagerModules.default` 在这个包之上提供 session 接线,
`packages.<system>.niri-glass` 可以在任何接收包的地方引用。

### install.sh(非 Nix 方式)

克隆仓库并跑安装脚本:

```bash
git clone https://github.com/YeFaDa/Niri-glass
cd Niri-glass
```

```bash
./install.sh /path/to/niri/src
```

> [!WARNING]
> 为了真正用上,你需要把现有的 niri 换成带改动的新二进制。操作方法是
> 退出登录管理器,回到 TTY,脚本会替换它。

如果没指定路径,默认是 `~/niri`。脚本会复制所有修改过的文件,重新编译 niri,
并装好二进制。

### 手动步骤

1. 把文件拷到你 niri 的 `src/` 目录
2. 在 niri 源码里跑 `cargo build --release`
3. 把 `target/release/niri` 拷到 `/usr/local/bin/niri-glass`(需要 sudo)

## 配置

### 推荐配置

先记住这条比值,它决定边缘的强弱:

```
A / H = (refraction-strength × 0.05) / edge-thickness
```

`A` 是边缘最大位移(px),`H` 是折射带宽(px)。**A/H ≥ 1.5 时边缘会出现镜像回折**,Kyant0 官方 demo 用的比例是 **2 : 1**。你的窗口圆角越小、窗口越窄,同一组参数看起来越猛。

**① 对齐 Kyant0(默认推荐)**

```kdl
window-rule {
    match app-id=".*"
    background-effect {
        blur true
        xray true                 // 必须 true,否则边缘会有 artifacts
        liquid-glass {
            physical-refraction 0 // 0 = kwin / AndroidLiquidGlass 路径(本 fork 的改动都在这条路上)
            refraction-strength 4.8   // A/H = (4.8 × 0.05) / 0.12 = 2.0,即 Kyant0 demo 比例
            edge-thickness 0.12       // H = 0.12 × 半短边
            corner-fan 1.5            // 虚拟圆角 = 圆角半径 × 1.5(= Kyant0 gradRadius)
            depth-effect 1            // = Kyant0 depthEffect,让整条边都朝角部倾
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

**② 更锐、几乎无回折(A/H ≈ 1.2)**

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

> 两个预设里的 `corner-fan` / `depth-effect` 本来就是代码默认值,写出来只是为了自文档化。
> 想让角部"散"得更多就加大 `corner-fan`,但 **超过 3 角部会出现回折螺旋**。

### 参数总表

#### 折射(核心)

| 参数 | 默认 | 作用 |
|---|---|---|
| `refraction-strength` | `1.0` | **总开关 + 幅度**。`0` = 完全关闭玻璃效果。实际强度 = `clamp(值 × 0.05, 0, 1)`,再乘半短边得到边缘最大位移 **A**(px) —— 也就是值到 `20` 就封顶。 |
| `edge-thickness` | `0.15` | 折射带宽 **H** = `值 × 半短边`(px)。越厚,折射向窗口内部延伸越深。 |
| `physical-refraction` | `0` | 折射模型。**`0` = kwin / AndroidLiquidGlass 路径**(本 fork 的改动都在这条路上);`≥ 0.5` = HyprGlass 路径。 |
| `corner-fan` | **`1.5`** | 方向场的角弧半径 = `值 × 该角真实圆角半径`。`1.0` = 直接用圆角矩形的 SDF 法线,角部会读成一个折肘;`1.5` 等于 Kyant0 的 `gradRadius = radius × 1.5`。再大(≥ 3)角部会出现回折螺旋。 |
| `depth-effect` | **`1.0`** | Kyant0 的 `depthEffect`:把「从窗口中心指向该点的径向」混进边缘法线,让**整条边**都朝角部倾,而不是只在角部扇形里才转。`0` = 关闭。 |
| `lens-distortion` | `0.0` | 中央半球透镜,把整个窗口内容做成放大镜。`0` = 只保留边缘折射。 |
| `edge-padding` | **`-1`(自动)** | 采集区向外扩的比例,`padding(px) = 值 × 窗口短边`。**只在 `xray false` 时生效**(xray 采整屏,不需要也不使用 padding)。<br>`-1`(默认)= **自动**,按 `refraction-strength × 0.025 × 1.2` 推导,保证刚好盖住最大折射位移,且随窗口尺寸自动缩放 —— 通常**不用手写**。<br>`0` = 关闭。`> 0` = 手动覆盖,必须是小数(写 `12` 就是 12× 短边)。 |

#### 观感(颜色与高光)

| 参数 | 默认 | 作用 |
|---|---|---|
| `fringing` | `0.3` | 七点光谱色散(Kyant0 的 chromaticAberration),边缘出现 RGB 彩边。 |
| `glow-weight` | `0.08` | 边框高光强度。 |
| `edge-lighting` | `1.0` | 边缘光:背景/壁纸的颜色向窗口边缘渗透。 |
| `power-factor` | `3.0` | 法线幂次,决定边缘过渡的软硬。两种模式都生效。 |
| `refraction-power` | `0.6` | 位移/斜面强度,**只在 HyprGlass 路径(`physical-refraction ≥ 0.5`)生效**。 |
| `brightness` | `1.0` | 亮度。 |
| `contrast` | `1.0` | 对比度。 |
| `saturation` | `0.85` | 饱和度。 |
| `vibrancy` | `0.12` | 鲜艳度:背景越灰,提亮越明显。 |
| `adaptive-dim` | `0.0` | 按采样区亮度自适应压暗。 |
| `adaptive-boost` | `0.0` | 按采样区亮度自适应提亮。 |

#### 已废弃

`refraction-a` / `refraction-b` / `refraction-c` / `refraction-d` / `glow-bias` / `glow-edge0` / `glow-edge1`
是 HyprGlass 时期的参数,**shader 里已经没有任何引用**,只剩兼容解析。新配置不用写。

#### 三种模式的优先级

`glass_effect()` 里按这个顺序选路,前一条命中就不看后面的:

1. `refraction-strength == 0` → 不做任何折射
2. `refraction-dilute > 0` → 「稀薄」模式(独立实现,**会绕过下面两条,`corner-fan` / `depth-effect` 随之失效**)
3. `physical-refraction < 0.5` → **kwin / AndroidLiquidGlass**(本 fork 的改动)
4. 其余 → HyprGlass

#### 关于 xray

`background-effect` 里的 `xray` 决定玻璃从哪取背景像素,两条路互斥:

| | `xray true` | `xray false` |
|---|---|---|
| 实现 | `Xray`(`src/render_helpers/xray.rs`) | `FramebufferEffect`(`framebuffer_effect.rs`) |
| 采样源 | 单独渲染的**整屏背景缓冲** | 只能对屏幕当前位置做 blit 截屏 |
| 能否读到窗口外像素 | 能 | **不能** |

折射位移方向是**朝窗口外**的(`glassInwardNormal` 在边缘指向窗外),所以:

- `xray true` → 窗外像素真实存在,边缘正常。**推荐用于普通窗口。**
- `xray false` → 采样源里没有窗外像素,越界只能 clamp,边缘像素被横向重复拖出,**即「边缘 artifacts / 拉丝」**。

要关 xray(比如层表面 overlay,本来就没有「背后」可穿)时,采集区必须外扩,否则仍有拉丝。**这一步是自动的**,默认 `edge-padding -1` 会按下面的公式推导,你不需要手写:

```kdl
// 自动推导(默认,edge-padding -1):
//   A(px)       = refraction-strength × 0.025 × 短边   (最大位移出现在窗口边缘, u=0)
//   padding(px) = 值 × 短边
//   ⇒ 值 = refraction-strength × 0.025 × 1.2   (含 20% 余量)
```

想手动覆盖就写正数(短边比例)。若要自己算,理论下限是:

| `refraction-strength` | 2 | 3 | 4 | 5 | 6 | 8 | 10 |
|---|---|---|---|---|---|---|---|
| 最小 `edge-padding` | 0.05 | 0.075 | 0.10 | 0.125 | 0.15 | 0.20 | 0.25 |

注意 `edge-padding` 上限 400,且是**短边比例**、非像素,所以同一份配置在不同尺寸窗口下自动等比缩放。

> ⚠️ 自动 padding 依赖 shader 里的 `windowSize` 修正(`clipped_surface.frag` 的 `main()`)。
> 没有这个修正时,SDF / 圆角 / 边界遮罩会误用**扩展后**的 `geo_size`,
> 导致玻璃整体视觉缩进去约 `1 - 短边/(短边+2×padding)`,`xray false` 的层表面会明显缩一圈。


### 磨砂玻璃外观的参数

```kdl
saturation 0.9
vibrancy 0.2
adaptive-dim 0.25
adaptive-boost 0.25
```

提高 `saturation` / `vibrancy` 并同时打开两个自适应项,背景会保持可读但变柔,
边缘高光也被压下去 —— 整体读起来是磨砂而不是抛光。把所有参数设为 `0`(只留
`saturation 1`)则完全去掉效果,调参时可以拿它当基准。

### 单个参数的说明

- `fringing` 会沿折射方向分离 RGB 通道(见[七点光谱色散](#七点光谱色散--fringing)),
  设 `0` 就完全没有彩边。
- `edge-lighting` 让壁纸的颜色渗进窗口边缘,高光会带上周边的色调而不是保持中性。
- `glow-weight` 是边框高光本身,设 `0` 会保留折射但去掉那圈亮边 ——
  这也是区分这两者最快的方法。

## 提示

- 这个项目是 vibe coded,可能会有奇怪的行为,请预期。
