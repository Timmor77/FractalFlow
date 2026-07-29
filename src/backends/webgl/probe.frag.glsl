#version 300 es
// Driver probe: does this GLSL compiler preserve error-free transformations?
//
// The double-single arithmetic of julia.frag.glsl only works if twoSum keeps
// the rounding residual. A compiler that contracts or reassociates the
// expression (fast-math) returns a low word of exactly zero, and the backend
// then silently degrades to plain f32 — deep views become wrong long before the
// theoretical 1e-14 floor. The operands arrive in a uniform so the whole thing
// cannot be constant-folded away.
precision highp float;

uniform vec2 u_probe; // (a, b) with |b| far below the f32 resolution of a

out vec4 outColor;

vec2 twoSum(float a, float b) {
  float s = a + b;
  float bb = s - a;
  return vec2(s, (a - (s - bb)) + (b - bb));
}

void main() {
  vec2 s = twoSum(u_probe.x, u_probe.y);
  // Correct rounding gives s.y ~= b. Anything much smaller means the residual
  // was optimised out. The quarter-magnitude margin keeps the test independent
  // of the exact rounding mode.
  float ok = abs(s.y) > 0.25 * abs(u_probe.y) ? 1.0 : 0.0;
  outColor = vec4(ok, 0.0, 0.0, 1.0);
}
