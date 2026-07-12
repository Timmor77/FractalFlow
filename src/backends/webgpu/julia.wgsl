// Julia render shader using PERTURBATION (WebGPU / WGSL).
//
// Each pixel does not compute z = z² + c directly. It tracks a small offset δ
// (delta) from the reference orbit precomputed on the CPU (see
// referenceOrbit.ts). Everything is f32: simple and fast — it is the high
// precision of the reference (CPU side) that unlocks deep zoom.
//
// Recurrence (Julia, c constant, hence no δc term):
//   z_n = Z[m] + δ
//   δ'  = 2·Z[m]·δ + δ²
// Zhuoran rebasing: when |z − Z0| becomes smaller than |δ|, or the reference
// runs out, restart from Z[0] with δ = z − Z0. This avoids glitches and
// stretches a single reference very deep.
//
// The orbit is stored RELATIVE to Z0 (D[m] = Z[m] − Z0, computed in
// double-double on the CPU), with Z0 itself in the uniforms. Storing absolute
// Z[m] would quantise the rebased delta D[m] + δ to the f32 grid of O(1)
// values (~1e-7): near a fixed point that error dwarfs pixel deltas and
// neighbouring pixels collapse onto the same delta — blocky glitches from
// ~1e-5 scales down. As offsets, D[m] and δ are both small exactly when
// precision matters, so their sum keeps full relative precision.

struct Uniforms {
  resolution : vec2f,
  scale : f32,      // vertical size of the view in the complex plane
  aspect : f32,     // width / height
  maxIter : u32,
  refLength : u32,  // number of valid points in the reference orbit
  center : vec2f,   // Z0 rounded to f32 (the orbit below is relative to it)
};

@group(0) @binding(0) var<uniform> u : Uniforms;

// Reference orbit relative to Z0: [Dx0, Dy0, Dx1, Dy1, ...] (D[0] = 0),
// viewed as an array of vec2f.
@group(0) @binding(1) var<storage, read> refOrbit : array<vec2f>;

// Palette as a colour lookup table (256×1 LUT) built on the CPU
// (ui/palettes.ts). Sampler in "repeat" mode -> smooth cyclic colouring.
@group(0) @binding(2) var paletteLut : texture_2d<f32>;
@group(0) @binding(3) var paletteSampler : sampler;

// Fullscreen triangle generated from the vertex index (no buffer needed).
@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
  var pts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(pts[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) fragCoord : vec4f) -> @location(0) vec4f {
  // Pixel position in 0..1, centred, aspect-corrected. Screen y -> complex y.
  let uv = fragCoord.xy / u.resolution;
  var p = uv - vec2f(0.5, 0.5);
  p.x = p.x * u.aspect;
  p.y = -p.y;

  // Initial δ = pixel offset from the centre = p * scale.
  // Even at extreme zoom (scale ~1e-28), this small value stays representable in f32.
  var d = p * u.scale;

  var m : u32 = 0u;          // index into the reference orbit
  var iter : u32 = 0u;       // current iteration
  var escaped = false;
  var zx = 0.0;
  var zy = 0.0;

  loop {
    if (iter >= u.maxIter) { break; }

    // z_n = Z[m] + δ, with Z[m] = Z0 + D[m]
    let D = refOrbit[m];
    let Zx = u.center.x + D.x;
    let Zy = u.center.y + D.y;
    zx = Zx + d.x;
    zy = Zy + d.y;
    if (zx * zx + zy * zy > 4.0) { escaped = true; break; }

    // δ' = 2·Z·δ + δ²
    let ndx = 2.0 * (Zx * d.x - Zy * d.y) + (d.x * d.x - d.y * d.y);
    let ndy = 2.0 * (Zx * d.y + Zy * d.x) + 2.0 * d.x * d.y;
    d = vec2f(ndx, ndy);
    m = m + 1u;
    iter = iter + 1u;

    // Rebasing: restart from Z[0] when δ loses precision (|z - Z0| < |δ|) or
    // when the reference runs out. The new delta is z - Z0 = D[m] + δ — a sum
    // of two orbit-relative offsets, both small exactly when the pixel orbit
    // is near the reference, so no catastrophic cancellation (see header).
    // min(...): when the reference has a single point (it escapes immediately),
    // m already equals refLength here; without the clamp we would read stale data.
    let D2 = refOrbit[min(m, u.refLength - 1u)];
    let fx = D2.x + d.x;
    let fy = D2.y + d.y;
    if ((fx * fx + fy * fy) < (d.x * d.x + d.y * d.y) || m >= u.refLength - 1u) {
      d = vec2f(fx, fy);
      m = 0u;
    }
  }

  // Point inside the set: black.
  if (!escaped) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }

  // Smooth colouring (smooth iteration count): avoids discrete bands.
  // NB: `smooth` is a reserved WGSL word, hence the name smoothIter.
  let mag2 = zx * zx + zy * zy;
  let nu = log2(0.5 * log2(mag2));           // log2(log2(|z|))
  let smoothIter = f32(iter) + 1.0 - nu;
  // Sample the LUT; the "repeat" sampler makes the palette cycle.
  // Log-damped colour density (identical in GLSL/CUDA/Python): a linear
  // t = smoothIter * 0.02 cycles the palette several times per pixel in dense
  // regions and dissolves them into grey speckle. The slope at 0 matches the
  // old 0.02 (5.545 = 0.02 * 400 / ln 2), so shallow views are unchanged.
  let t = 5.545 * log2(1.0 + smoothIter / 400.0);
  let rgb = textureSampleLevel(paletteLut, paletteSampler, vec2f(t, 0.5), 0.0).rgb;
  return vec4f(rgb, 1.0);
}
