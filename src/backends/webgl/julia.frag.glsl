#version 300 es
// Julia render shader for the WebGL2 COMPATIBILITY backend.
//
// No perturbation here: this shader iterates z = z² + c directly, with every
// coordinate in "double-single" form (a float64-ish value carried as
// vec2(hi, lo) of two f32). That is simple and runs everywhere, but it tops out
// near a view scale of 1e-14 — and only when the driver compiles the
// error-free transformations as written. Some GLSL compilers contract them with
// fast-math and drop the low word entirely, which silently reduces the whole
// thing to plain f32; webglRenderer.ts probes for that at start-up.
//
// The iteration order below (test, then advance) is the one used by the WebGPU
// shader, the CUDA kernel and the Python reference, so the smooth iteration
// count means the same thing in all four.
precision highp float;

uniform vec2 u_resolution;
uniform vec2 u_centerHigh; // (centerX.hi, centerY.hi)
uniform vec2 u_centerLow;  // (centerX.lo, centerY.lo)
uniform vec2 u_scaleDS;    // (scale.hi, scale.lo)
uniform vec2 u_cHigh;      // (cx.hi, cy.hi)
uniform vec2 u_cLow;       // (cx.lo, cy.lo)
uniform int u_maxIter;

// Palette colour lookup table (256×1 LUT), sampled by the smooth iteration
// count. Texture in "repeat" mode -> cyclic colouring.
uniform sampler2D u_lut;

out vec4 outColor;

// --- Double-single primitives (a = vec2(hi, lo)) ---
vec2 twoSum(float a, float b) {
  float s = a + b;
  float bb = s - a;
  return vec2(s, (a - (s - bb)) + (b - bb));
}
vec2 quickTwoSum(float a, float b) {
  float s = a + b;
  return vec2(s, b - (s - a));
}
vec2 splitFloat(float a) {
  float t = 4097.0 * a; // 2^12 + 1, suited to 24-bit mantissas
  float hi = t - (t - a);
  return vec2(hi, a - hi);
}
vec2 twoProd(float a, float b) {
  float p = a * b;
  vec2 as = splitFloat(a);
  vec2 bs = splitFloat(b);
  return vec2(p, ((as.x * bs.x - p) + as.x * bs.y + as.y * bs.x) + as.y * bs.y);
}
vec2 dsAdd(vec2 a, vec2 b) {
  vec2 s = twoSum(a.x, b.x);
  return quickTwoSum(s.x, s.y + a.y + b.y);
}
vec2 dsSub(vec2 a, vec2 b) { return dsAdd(a, vec2(-b.x, -b.y)); }
vec2 dsMul(vec2 a, vec2 b) {
  vec2 p = twoProd(a.x, b.x);
  p.y += a.x * b.y + a.y * b.x;
  return quickTwoSum(p.x, p.y);
}
vec2 dsMulFloat(vec2 a, float b) {
  vec2 p = twoProd(a.x, b);
  p.y += a.y * b;
  return quickTwoSum(p.x, p.y);
}
float dsToFloat(vec2 a) { return a.x + a.y; }

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 p = uv - 0.5;
  p.x *= u_resolution.x / u_resolution.y;

  // Screen offset -> complex plane, in double-single.
  vec2 offsetX = dsMulFloat(u_scaleDS, p.x);
  vec2 offsetY = dsMulFloat(u_scaleDS, p.y);

  vec2 zRe = dsAdd(vec2(u_centerHigh.x, u_centerLow.x), offsetX);
  vec2 zIm = dsAdd(vec2(u_centerHigh.y, u_centerLow.y), offsetY);

  vec2 cRe = vec2(u_cHigh.x, u_cLow.x);
  vec2 cIm = vec2(u_cHigh.y, u_cLow.y);

  int iter = 0;
  float mag2 = 0.0;
  bool escaped = false;

  // Constant bound required by WebGL2, strictly > MAX_ITER_LIMIT (TypeScript).
  for (int i = 0; i < 4096; i++) {
    if (i >= u_maxIter) { break; }

    // Escape test on the CURRENT z, before advancing: iter is then the number
    // of completed iterations, exactly as in julia.wgsl, julia.cu and
    // reference_julia.py. Testing after the update would shift every smooth
    // iteration count by one and miss a starting point already outside the
    // escape radius.
    float zr = dsToFloat(zRe);
    float zi = dsToFloat(zIm);
    mag2 = zr * zr + zi * zi;
    if (mag2 > 4.0) { iter = i; escaped = true; break; }

    // z² = (x² - y²) + i(2xy)
    vec2 x2 = dsMul(zRe, zRe);
    vec2 y2 = dsMul(zIm, zIm);
    vec2 xy = dsMul(zRe, zIm);
    zRe = dsAdd(dsSub(x2, y2), cRe);
    zIm = dsAdd(dsMulFloat(xy, 2.0), cIm);
  }

  if (!escaped) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Smooth colouring, identical to the other backends (samples the LUT).
  // Log-damped colour density — see julia.wgsl for the rationale.
  float nu = log2(0.5 * log2(mag2));
  float smoothIter = float(iter) + 1.0 - nu;
  float t = 5.545 * log2(1.0 + smoothIter / 400.0);
  outColor = vec4(texture(u_lut, vec2(t, 0.5)).rgb, 1.0);
}
