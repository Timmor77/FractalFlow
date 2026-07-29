#version 300 es
// Fullscreen pass-through: the fragment shader does all the work.
precision highp float;
in vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
