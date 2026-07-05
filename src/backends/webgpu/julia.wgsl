// Shader de rendu Julia par PERTURBATION (WebGPU / WGSL).
//
// Chaque pixel ne calcule pas z = z² + c directement. Il suit un petit écart δ
// (delta) par rapport à l'orbite de référence pré-calculée sur le CPU (voir
// referenceOrbit.ts). Tout est en f32 : c'est simple et rapide, et c'est la
// haute précision de la référence (côté CPU) qui débloque le deep zoom.
//
// Récurrence (Julia, c constant, donc pas de terme δc) :
//   z_n = Z[m] + δ
//   δ'  = 2·Z[m]·δ + δ²
// Rebasing de Zhuoran : quand |z| devient plus petit que |δ|, ou qu'on atteint
// la fin de la référence, on repart de Z[0] avec δ = z. Ça évite les artefacts
// et prolonge une référence unique très profondément.

struct Uniforms {
  resolution : vec2f,
  scale : f32,      // taille verticale de la vue dans le plan complexe
  aspect : f32,     // largeur / hauteur
  maxIter : u32,
  refLength : u32,  // nombre de points valides dans l'orbite de référence
};

@group(0) @binding(0) var<uniform> u : Uniforms;

// Orbite de référence : [Zx0, Zy0, Zx1, Zy1, ...] vue comme un tableau de vec2f.
@group(0) @binding(1) var<storage, read> refOrbit : array<vec2f>;

// Palette sous forme de table de couleurs (LUT 256×1) construite par le CPU
// (ui/palettes.ts). Sampler en mode « repeat » -> coloration cyclique et douce.
@group(0) @binding(2) var paletteLut : texture_2d<f32>;
@group(0) @binding(3) var paletteSampler : sampler;

// Triangle plein écran généré à partir de l'index de sommet (aucun buffer requis).
@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
  var pts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pts[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) fragCoord : vec4f) -> @location(0) vec4f {
  // Position du pixel en 0..1, centrée, corrigée de l'aspect. y écran -> y complexe.
  let uv = fragCoord.xy / u.resolution;
  var p = uv - vec2f(0.5, 0.5);
  p.x = p.x * u.aspect;
  p.y = -p.y;

  // δ initial = offset du pixel par rapport au centre = p * scale.
  // Même à très fort zoom (scale ~1e-28), cette petite valeur reste représentable en f32.
  var d = p * u.scale;

  let Z0 = refOrbit[0];      // point de départ de la référence (= centre de la vue)
  var m : u32 = 0u;          // index dans l'orbite de référence
  var iter : u32 = 0u;       // itération courante
  var escaped = false;
  var zx = 0.0;
  var zy = 0.0;

  loop {
    if (iter >= u.maxIter) { break; }

    // z_n = Z[m] + δ
    let Z = refOrbit[m];
    zx = Z.x + d.x;
    zy = Z.y + d.y;
    if (zx * zx + zy * zy > 4.0) { escaped = true; break; }

    // δ' = 2·Z·δ + δ²
    let ndx = 2.0 * (Z.x * d.x - Z.y * d.y) + (d.x * d.x - d.y * d.y);
    let ndy = 2.0 * (Z.x * d.y + Z.y * d.x) + 2.0 * d.x * d.y;
    d = vec2f(ndx, ndy);
    m = m + 1u;
    iter = iter + 1u;

    // Rebasing : on repart de Z[0] quand δ perd en précision (|z - Z0| < |δ|)
    // ou quand on atteint la fin de la référence. Le nouveau delta est
    // z - Z[0] (et non z), ce qui préserve l'invariant z = Z[m] + δ pour Z0 ≠ 0.
    let Z2 = refOrbit[m];
    let fx = Z2.x + d.x - Z0.x;
    let fy = Z2.y + d.y - Z0.y;
    if ((fx * fx + fy * fy) < (d.x * d.x + d.y * d.y) || m >= u.refLength - 1u) {
      d = vec2f(fx, fy);
      m = 0u;
    }
  }

  // Point à l'intérieur de l'ensemble : noir.
  if (!escaped) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }

  // Coloration lissée (smooth iteration count) : évite les bandes discrètes.
  // NB : `smooth` est un mot réservé WGSL, on nomme la variable smoothIter.
  let mag2 = zx * zx + zy * zy;
  let nu = log2(0.5 * log2(mag2));           // log2(log2(|z|))
  let smoothIter = f32(iter) + 1.0 - nu;
  // Échantillonne la LUT ; le sampler « repeat » fait cycler la palette.
  let t = smoothIter * 0.02;
  let rgb = textureSampleLevel(paletteLut, paletteSampler, vec2f(t, 0.5), 0.0).rgb;
  return vec4f(rgb, 1.0);
}
