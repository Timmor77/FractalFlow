/**
 * Owns the WebGL2 context, GPU resources, uniforms, resize, and draw calls.
 * Fractal formulas belong in GLSL; input handling does not belong here.
 */

// Ce fichier contient toute la logique WebGL2.
// Le but est d'éviter de mettre le code GPU directement dans main.ts.

// Le vertex shader est un petit programme qui tourne sur le GPU.
// Ici, il sert seulement à afficher deux triangles qui couvrent tout l'écran.
const vertexShaderSource = `#version 300 es

// On demande une précision correcte pour les floats dans le shader.
precision highp float;

// Attribut reçu depuis le buffer TypeScript.
// Chaque sommet aura une position 2D : x, y.
in vec2 a_position;

void main() {
  // gl_Position est la position finale du sommet à l'écran.
  // WebGL attend un vec4 : x, y, z, w.
  // z = 0.0 car on fait de la 2D.
  // w = 1.0 valeur standard pour les coordonnées homogènes.
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Le fragment shader tourne pour chaque pixel couvert par les triangles.
// Ici, il va juste afficher un dégradé selon la position du pixel.
const fragmentShaderSource = `#version 300 es

// On demande une précision correcte pour les floats.
precision highp float;

// Uniform envoyé depuis TypeScript.
// Il contient la résolution réelle du canvas en pixels.
uniform vec2 u_resolution;

// Couleur finale du pixel.
// En WebGL2, on doit déclarer explicitement la sortie.
out vec4 outColor;

void main() {
  // gl_FragCoord.xy contient la position du pixel courant.
  // Exemple : pixel en bas à gauche ≈ (0, 0).
  // Pixel en haut à droite ≈ (width, height).
  vec2 pixel = gl_FragCoord.xy;

  // On normalise la position du pixel entre 0 et 1.
  // uv.x = 0 à gauche, 1 à droite.
  // uv.y = 0 en bas, 1 en haut.
  vec2 uv = pixel / u_resolution;

  // On crée une couleur simple :
  // rouge dépend de x,
  // vert dépend de y,
  // bleu reste constant.
  vec3 color = vec3(uv.x, uv.y, 0.5);

  // On écrit la couleur finale du pixel.
  // Le dernier nombre est l'opacité alpha : 1.0 = opaque.
  outColor = vec4(color, 1.0);
}
`;

// Cette fonction compile un shader GLSL.
// Un shader est du code texte que WebGL doit compiler pour le GPU.
function createShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  // On crée un objet shader vide côté WebGL.
  const shader = gl.createShader(type);

  // Si la création échoue, on arrête avec une erreur claire.
  if (!shader) {
    throw new Error("Failed to create shader");
  }

  // On donne le code source GLSL au shader.
  gl.shaderSource(shader, source);

  // On demande à WebGL de compiler le shader.
  gl.compileShader(shader);

  // On vérifie si la compilation a réussi.
  const success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);

  // Si la compilation échoue, on récupère le message d'erreur GLSL.
  if (!success) {
    const log = gl.getShaderInfoLog(shader);

    // On supprime le shader raté pour éviter de garder des ressources inutiles.
    gl.deleteShader(shader);

    // On affiche l'erreur.
    throw new Error(`Shader compilation failed:\n${log}`);
  }

  // Si tout va bien, on renvoie le shader compilé.
  return shader;
}

// Cette fonction crée un programme WebGL complet.
// Un programme WebGL = vertex shader + fragment shader liés ensemble.
function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  // On compile le vertex shader.
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);

  // On compile le fragment shader.
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);

  // On crée un programme WebGL vide.
  const program = gl.createProgram();

  // Si la création échoue, on arrête.
  if (!program) {
    throw new Error("Failed to create WebGL program");
  }

  // On attache le vertex shader au programme.
  gl.attachShader(program, vertexShader);

  // On attache le fragment shader au programme.
  gl.attachShader(program, fragmentShader);

  // On lie les deux shaders ensemble.
  gl.linkProgram(program);

  // On vérifie que le linking a réussi.
  const success = gl.getProgramParameter(program, gl.LINK_STATUS);

  // Si le linking échoue, on affiche l'erreur.
  if (!success) {
    const log = gl.getProgramInfoLog(program);

    // On supprime le programme raté.
    gl.deleteProgram(program);

    // On arrête avec une erreur claire.
    throw new Error(`Program linking failed:\n${log}`);
  }

  // Une fois le programme créé, les shaders individuels ne sont plus nécessaires.
  gl.deleteShader(vertexShader);

  // Même chose pour le fragment shader.
  gl.deleteShader(fragmentShader);

  // On renvoie le programme WebGL prêt à être utilisé.
  return program;
}

// Classe principale qui gère le rendu WebGL2.
export class WebGLRenderer {
  // Canvas HTML où on dessine.
  private readonly canvas: HTMLCanvasElement;

  // Contexte WebGL2 utilisé pour parler au GPU.
  private readonly gl: WebGL2RenderingContext;

  // Programme GPU : vertex shader + fragment shader.
  private readonly program: WebGLProgram;

  // Emplacement du uniform u_resolution dans le shader.
  private readonly resolutionLocation: WebGLUniformLocation;

  // Le constructeur prépare tout ce qui est nécessaire au rendu.
  constructor(canvas: HTMLCanvasElement) {
    // On garde une référence au canvas.
    this.canvas = canvas;

    // On demande le contexte WebGL2 au navigateur.
    const gl = canvas.getContext("webgl2");

    // Si WebGL2 n'est pas supporté, on arrête.
    if (!gl) {
      throw new Error("WebGL2 is not supported by this browser or device");
    }

    // On garde le contexte WebGL2 dans la classe.
    this.gl = gl;

    // On crée le programme GPU.
    this.program = createProgram(gl);

    // On récupère la position de l'attribut a_position dans le vertex shader.
    const positionLocation = gl.getAttribLocation(this.program, "a_position");

    // Si l'attribut n'existe pas, il y a un problème dans le shader.
    if (positionLocation === -1) {
      throw new Error("Attribute not found: a_position");
    }

    // On crée un buffer GPU.
    // Il va contenir les positions des sommets.
    const positionBuffer = gl.createBuffer();

    // Si la création échoue, on arrête.
    if (!positionBuffer) {
      throw new Error("Failed to create position buffer");
    }

    // On dit à WebGL que ce buffer devient le buffer actif de type ARRAY_BUFFER.
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);

    // Ces 6 points forment 2 triangles.
    // Les deux triangles couvrent tout l'écran.
    // Coordonnées WebGL :
    // x = -1 gauche, x = 1 droite
    // y = -1 bas,    y = 1 haut
    const positions = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,

      -1,  1,
       1, -1,
       1,  1,
    ]);

    // On envoie les positions dans le buffer GPU.
    // STATIC_DRAW signifie que les données ne changeront presque jamais.
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    // Un VAO mémorise comment lire les buffers.
    // VAO = Vertex Array Object.
    const vao = gl.createVertexArray();

    // Si la création échoue, on arrête.
    if (!vao) {
      throw new Error("Failed to create vertex array object");
    }

    // On active ce VAO.
    gl.bindVertexArray(vao);

    // On active l'attribut a_position.
    gl.enableVertexAttribArray(positionLocation);

    // On explique à WebGL comment lire le buffer :
    // - chaque sommet contient 2 floats
    // - type = FLOAT
    // - pas de normalisation
    // - stride = 0 : données compactes
    // - offset = 0 : on commence au début du buffer
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    // On récupère l'emplacement du uniform u_resolution.
    const resolutionLocation = gl.getUniformLocation(this.program, "u_resolution");

    // Si le uniform n'existe pas, on arrête.
    if (!resolutionLocation) {
      throw new Error("Uniform not found: u_resolution");
    }

    // On garde l'emplacement pour pouvoir l'envoyer à chaque frame.
    this.resolutionLocation = resolutionLocation;
  }

  // Fonction appelée à chaque frame par main.ts.
  render(): void {
    // On vérifie que le canvas a la bonne taille.
    this.resizeCanvasIfNeeded();

    // On récupère le contexte WebGL2.
    const gl = this.gl;

    // On dit à WebGL d'utiliser notre programme GPU.
    gl.useProgram(this.program);

    // On envoie la résolution réelle du canvas au shader.
    gl.uniform2f(this.resolutionLocation, this.canvas.width, this.canvas.height);

    // On dessine 6 sommets.
    // Ces 6 sommets forment 2 triangles plein écran.
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Ajuste la résolution interne du canvas si nécessaire.
  private resizeCanvasIfNeeded(): void {
    // devicePixelRatio prend en compte les écrans haute densité.
    const pixelRatio = window.devicePixelRatio || 1;

    // Largeur réelle nécessaire en pixels.
    const width = Math.floor(this.canvas.clientWidth * pixelRatio);

    // Hauteur réelle nécessaire en pixels.
    const height = Math.floor(this.canvas.clientHeight * pixelRatio);

    // Si la taille est déjà correcte, on ne fait rien.
    if (this.canvas.width === width && this.canvas.height === height) {
      return;
    }

    // On met à jour la largeur interne du canvas.
    this.canvas.width = width;

    // On met à jour la hauteur interne du canvas.
    this.canvas.height = height;

    // On dit à WebGL que le rendu doit couvrir tout le canvas.
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }
}