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
// Zhuoran rebasing: when |z| becomes smaller than |δ|, or the reference runs
// out, restart from Z[0] with δ = z. This avoids glitches and stretches a
// single reference very deep.

struct Uniforms {
  resolution : vec2f,
  scale : f32,      // vertical size of the view in the complex plane
  aspect : f32,     // width / height
  maxIter : u32,
  refLength : u32,  // number of valid points in the reference orbit
};

@group(0) @binding(0) var<uniform> u : Uniforms;

// Reference orbit: [Zx0, Zy0, Zx1, Zy1, ...] viewed as an array of vec2f.
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

  let Z0 = refOrbit[0];      // reference starting point (= view centre)
  var m : u32 = 0u;          // index into the reference orbit
  var iter : u32 = 0u;       // current iteration
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

    // Rebasing: restart from Z[0] when δ loses precision (|z - Z0| < |δ|) or
    // when the reference runs out. The new delta is z - Z[0] (not z), which
    // preserves the invariant z = Z[m] + δ when Z0 ≠ 0.
    // min(...): when the reference has a single point (it escapes immediately),
    // m already equals refLength here; without the clamp we would read stale data.
    let Z2 = refOrbit[min(m, u.refLength - 1u)];
    let fx = Z2.x + d.x - Z0.x;
    let fy = Z2.y + d.y - Z0.y;
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
  let t = smoothIter * 0.02;
  let rgb = textureSampleLevel(paletteLut, paletteSampler, vec2f(t, 0.5), 0.0).rgb;
  return vec4f(rgb, 1.0);
}
