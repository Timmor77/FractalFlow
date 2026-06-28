// On importe la classe Viewport.
// Elle gère les maths de caméra : centre, zoom, pan, conversion écran -> plan complexe.
import { Viewport } from "../math/viewport";


// Overlay HTML qui affiche les infos de rendu.
import { StatsOverlay } from "../ui/stats";


// Vertex shader : programme GPU exécuté pour chaque sommet.
// Ici, il sert seulement à dessiner deux triangles qui couvrent tout l'écran.
const vertexShaderSource = `#version 300 es

precision highp float;

in vec2 a_position;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Fragment shader : programme GPU exécuté pour chaque pixel.
// C'est ici qu'on calcule l'ensemble de Julia.
const fragmentShaderSource = `#version 300 es

precision highp float;

uniform vec2 u_resolution;
uniform vec2 u_center;
uniform float u_scale;
uniform vec2 u_c;
uniform int u_maxIter;

out vec4 outColor;

vec3 palette(float t) {
  return 0.5 + 0.5 * cos(6.28318 * (vec3(0.00, 0.33, 0.67) + t));
}

void main() {
  vec2 pixel = gl_FragCoord.xy;

  vec2 uv = pixel / u_resolution;

  vec2 p = uv - 0.5;

  p.x *= u_resolution.x / u_resolution.y;

  vec2 z = u_center + p * u_scale;

  int iter = 0;

  for (int i = 0; i < 2000; i++) {
    if (i >= u_maxIter) {
      iter = u_maxIter;
      break;
    }

    float x = z.x * z.x - z.y * z.y + u_c.x;
    float y = 2.0 * z.x * z.y + u_c.y;

    z = vec2(x, y);

    if (dot(z, z) > 4.0) {
      iter = i;
      break;
    }
  }

  if (iter == u_maxIter) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  float t = float(iter) / float(u_maxIter);

  vec3 color = palette(t);

  outColor = vec4(color, 1.0);
}
`;

// Compile un shader GLSL.
// type vaut soit gl.VERTEX_SHADER, soit gl.FRAGMENT_SHADER.
function createShader(
    gl: WebGL2RenderingContext,
    type: number,
    source: string,
): WebGLShader {
    // Crée un objet shader WebGL.
    const shader = gl.createShader(type);

    // Si WebGL échoue à créer le shader, on arrête.
    if (!shader) {
        throw new Error("Failed to create shader");
    }

    // Envoie le code GLSL au shader.
    gl.shaderSource(shader, source);

    // Compile le shader.
    gl.compileShader(shader);

    // Vérifie si la compilation a réussi.
    const success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);

    // Si la compilation échoue, on récupère le log d'erreur.
    if (!success) {
        const log = gl.getShaderInfoLog(shader);

        // Supprime le shader invalide.
        gl.deleteShader(shader);

        // Affiche une erreur claire.
        throw new Error(`Shader compilation failed:\n${log}`);
    }

    // Renvoie le shader compilé.
    return shader;
}

// Crée un programme WebGL complet.
// Un programme = vertex shader + fragment shader liés ensemble.
function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
    // Compile le vertex shader.
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);

    // Compile le fragment shader.
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);

    // Crée un programme WebGL vide.
    const program = gl.createProgram();

    // Si la création échoue, on arrête.
    if (!program) {
        throw new Error("Failed to create WebGL program");
    }

    // Attache le vertex shader au programme.
    gl.attachShader(program, vertexShader);

    // Attache le fragment shader au programme.
    gl.attachShader(program, fragmentShader);

    // Lie les shaders ensemble.
    gl.linkProgram(program);

    // Vérifie si le linking a réussi.
    const success = gl.getProgramParameter(program, gl.LINK_STATUS);

    // Si le linking échoue, on récupère le log.
    if (!success) {
        const log = gl.getProgramInfoLog(program);

        // Supprime le programme invalide.
        gl.deleteProgram(program);

        // Affiche une erreur claire.
        throw new Error(`Program linking failed:\n${log}`);
    }

    // Une fois le programme créé, les shaders séparés ne sont plus nécessaires.
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    // Renvoie le programme prêt à être utilisé.
    return program;
}

// Récupère l'emplacement d'un uniform dans le shader.
function getUniformLocation(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    name: string,
): WebGLUniformLocation {
    // Demande à WebGL l'emplacement du uniform.
    const location = gl.getUniformLocation(program, name);

    // Si location est null, le uniform est absent ou optimisé.
    if (location === null) {
        throw new Error(`Uniform not found: ${name}`);
    }

    // Renvoie l'emplacement utilisable avec gl.uniform...
    return location;
}

// Renderer principal WebGL2.
export class WebGLRenderer {
    // Canvas HTML où WebGL dessine.
    private readonly canvas: HTMLCanvasElement;

    // Overlay de stats affiché en haut à gauche.
    private readonly stats = new StatsOverlay();

    // Nombre total de rendus effectués.
    private renderCount = 0;

    // Contexte WebGL2.
    private readonly gl: WebGL2RenderingContext;

    // Programme GPU : vertex shader + fragment shader.
    private readonly program: WebGLProgram;

    // VAO = Vertex Array Object.
    // Il mémorise comment lire les sommets.
    private readonly vao: WebGLVertexArrayObject;

    // Uniform : résolution réelle du canvas.
    private readonly resolutionLocation: WebGLUniformLocation;

    // Uniform : centre de la caméra dans le plan complexe.
    private readonly centerLocation: WebGLUniformLocation;

    // Uniform : niveau de zoom.
    private readonly scaleLocation: WebGLUniformLocation;

    // Uniform : paramètre c de Julia.
    private readonly cLocation: WebGLUniformLocation;

    // Uniform : nombre maximum d'itérations.
    private readonly maxIterLocation: WebGLUniformLocation;

    // Viewport = caméra mathématique.
    // Il contient centerX, centerY, scale, zoomAt(), panByPixels().
    private readonly viewport = new Viewport();

    // Partie réelle du paramètre c de Julia.
    private cRe = -0.8;

    // Partie imaginaire du paramètre c de Julia.
    private cIm = 0.156;

    // Nombre maximum d'itérations.
    private maxIter = 300;

    // Indique si l'utilisateur est en train de déplacer la vue.
    private isDragging = false;

    // Dernière position X connue de la souris pendant le drag.
    private lastMouseX = 0;

    // Dernière position Y connue de la souris pendant le drag.
    private lastMouseY = 0;

    // Identifiant de frame programmée avec requestAnimationFrame.
    // null signifie qu'aucun rendu n'est prévu.
    private animationFrameId: number | null = null;

    // Constructeur : initialise WebGL, les shaders, les buffers et les contrôles.
    constructor(canvas: HTMLCanvasElement) {
        // Garde une référence au canvas.
        this.canvas = canvas;

        // Demande un contexte WebGL2 au navigateur.
        const gl = canvas.getContext("webgl2");

        // Si WebGL2 n'est pas disponible, on arrête.
        if (!gl) {
            throw new Error("WebGL2 is not supported by this browser or device");
        }

        // Sauvegarde le contexte WebGL2.
        this.gl = gl;

        // Crée le programme GPU.
        this.program = createProgram(gl);

        // Récupère l'emplacement de l'attribut a_position.
        const positionLocation = gl.getAttribLocation(this.program, "a_position");

        // Si -1, l'attribut n'existe pas ou n'est pas utilisé.
        if (positionLocation === -1) {
            throw new Error("Attribute not found: a_position");
        }

        // Crée un buffer GPU pour les sommets.
        const positionBuffer = gl.createBuffer();

        // Vérifie que le buffer a bien été créé.
        if (!positionBuffer) {
            throw new Error("Failed to create position buffer");
        }

        // Active ce buffer comme ARRAY_BUFFER courant.
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);

        // Positions de 6 sommets formant 2 triangles plein écran.
        const positions = new Float32Array([
            -1, -1,
            1, -1,
            -1, 1,

            -1, 1,
            1, -1,
            1, 1,
        ]);

        // Envoie ces positions dans le buffer GPU.
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

        // Crée un VAO pour mémoriser comment lire le buffer.
        const vao = gl.createVertexArray();

        // Vérifie que le VAO a été créé.
        if (!vao) {
            throw new Error("Failed to create vertex array object");
        }

        // Sauvegarde le VAO dans la classe.
        this.vao = vao;

        // Active le VAO.
        gl.bindVertexArray(this.vao);

        // Active l'attribut a_position.
        gl.enableVertexAttribArray(positionLocation);

        // Explique à WebGL comment lire les données :
        // 2 floats par sommet, données compactes, à partir du début du buffer.
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

        // Récupère les uniforms utilisés par le fragment shader.
        this.resolutionLocation = getUniformLocation(gl, this.program, "u_resolution");
        this.centerLocation = getUniformLocation(gl, this.program, "u_center");
        this.scaleLocation = getUniformLocation(gl, this.program, "u_scale");
        this.cLocation = getUniformLocation(gl, this.program, "u_c");
        this.maxIterLocation = getUniformLocation(gl, this.program, "u_maxIter");

        // Configure les contrôles souris.
        this.setupControls();

        // Quand la fenêtre change de taille, il faut redessiner.
        window.addEventListener("resize", () => {
            this.requestRender();
        });
    }

    // Demande un rendu à la prochaine frame navigateur.
    // Si un rendu est déjà prévu, on n'en programme pas un autre.
    public requestRender(): void {
        // Si une frame est déjà programmée, on sort.
        if (this.animationFrameId !== null) {
            return;
        }

        // Programme un rendu à la prochaine frame.
        this.animationFrameId = requestAnimationFrame(() => {
            // Marque la frame comme consommée.
            this.animationFrameId = null;

            // Dessine l'image.
            this.render();
        });
    }

    // Configure zoom et déplacement souris.
    private setupControls(): void {
        // Zoom avec la molette autour du curseur.
        this.canvas.addEventListener("wheel", (event: WheelEvent) => {
            // Empêche le scroll de la page.
            event.preventDefault();

            // Récupère le rectangle du canvas dans la page.
            const rect = this.canvas.getBoundingClientRect();

            // Délègue le zoom au viewport.
            this.viewport.zoomAt(event.clientX, event.clientY, rect, event.deltaY);

            // La vue a changé, donc il faut redessiner.
            this.requestRender();
        });

        // Début du drag souris.
        this.canvas.addEventListener("mousedown", (event: MouseEvent) => {
            // On ne prend que le clic gauche.
            if (event.button !== 0) {
                return;
            }

            // Active le mode drag.
            this.isDragging = true;

            // Sauvegarde la position initiale.
            this.lastMouseX = event.clientX;
            this.lastMouseY = event.clientY;
        });

        // Mouvement souris pendant le drag.
        window.addEventListener("mousemove", (event: MouseEvent) => {
            // Si on ne drag pas, on ignore.
            if (!this.isDragging) {
                return;
            }

            // Déplacement horizontal en pixels.
            const deltaX = event.clientX - this.lastMouseX;

            // Déplacement vertical en pixels.
            const deltaY = event.clientY - this.lastMouseY;

            // Met à jour la dernière position souris.
            this.lastMouseX = event.clientX;
            this.lastMouseY = event.clientY;

            // Largeur CSS du canvas.
            const width = this.canvas.clientWidth;

            // Hauteur CSS du canvas.
            const height = this.canvas.clientHeight;

            // Délègue le déplacement au viewport.
            this.viewport.panByPixels(deltaX, deltaY, width, height);

            // La vue a changé, donc il faut redessiner.
            this.requestRender();
        });

        // Fin du drag souris.
        window.addEventListener("mouseup", () => {
            // Désactive le mode drag.
            this.isDragging = false;
        });

        // Si la fenêtre perd le focus, on arrête aussi le drag.
        window.addEventListener("blur", () => {
            // Évite de rester bloqué en mode drag.
            this.isDragging = false;
        });
    }

    // Dessine réellement une frame.
    private render(): void {

        // Mesure CPU approximative du temps de rendu.
        // Ce n'est pas encore une mesure GPU précise.
        const renderStart = performance.now();

        // Ajuste la résolution interne du canvas si nécessaire.
        this.resizeCanvasIfNeeded();

        // Raccourci local vers le contexte WebGL2.
        const gl = this.gl;

        // Utilise notre programme GPU.
        gl.useProgram(this.program);

        // Active le VAO qui contient le rectangle plein écran.
        gl.bindVertexArray(this.vao);

        // Envoie la résolution réelle au shader.
        gl.uniform2f(this.resolutionLocation, this.canvas.width, this.canvas.height);

        // Envoie le centre de la vue au shader.
        gl.uniform2f(
            this.centerLocation,
            this.viewport.centerX,
            this.viewport.centerY,
        );

        // Envoie le niveau de zoom au shader.
        gl.uniform1f(this.scaleLocation, this.viewport.scale);

        // Envoie le paramètre c de Julia au shader.
        gl.uniform2f(this.cLocation, this.cRe, this.cIm);

        // Envoie le nombre maximum d'itérations au shader.
        gl.uniform1i(this.maxIterLocation, this.maxIter);

        // Dessine 6 sommets = 2 triangles = rectangle plein écran.
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // Fin de la mesure CPU.
        const renderEnd = performance.now();

        // Incrémente le nombre total de rendus.
        this.renderCount += 1;

        // Met à jour l'overlay de stats.
        this.stats.update({
            renderCount: this.renderCount,
            lastRenderMs: renderEnd - renderStart,
            centerX: this.viewport.centerX,
            centerY: this.viewport.centerY,
            scale: this.viewport.scale,
            maxIter: this.maxIter,
        });
    }

    // Ajuste la résolution interne du canvas.
    private resizeCanvasIfNeeded(): void {
        // Prend en compte les écrans haute densité.
        const pixelRatio = window.devicePixelRatio || 1;

        // Largeur réelle en pixels.
        const width = Math.floor(this.canvas.clientWidth * pixelRatio);

        // Hauteur réelle en pixels.
        const height = Math.floor(this.canvas.clientHeight * pixelRatio);

        // Si la taille est déjà correcte, on ne fait rien.
        if (this.canvas.width === width && this.canvas.height === height) {
            return;
        }

        // Met à jour la largeur interne.
        this.canvas.width = width;

        // Met à jour la hauteur interne.
        this.canvas.height = height;

        // Dit à WebGL d'utiliser toute la surface du canvas.
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
}