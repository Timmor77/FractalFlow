// Ce fichier contient toute la logique WebGL2.
// main.ts doit seulement créer le canvas et appeler WebGLRenderer.render().

// Vertex shader : programme GPU exécuté pour chaque sommet.
// Ici il sert uniquement à dessiner un rectangle plein écran avec 2 triangles.
const vertexShaderSource = `#version 300 es

// Précision des nombres flottants dans le shader.
precision highp float;

// Position 2D de chaque sommet envoyée depuis TypeScript.
in vec2 a_position;

void main() {
  // Position finale du sommet dans l'espace écran WebGL.
  // x et y vont de -1 à 1.
  // z = 0 car on fait de la 2D.
  // w = 1 valeur standard pour les coordonnées homogènes.
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Fragment shader : programme GPU exécuté pour chaque pixel.
// C'est ici que l'ensemble de Julia est calculé.
const fragmentShaderSource = `#version 300 es

// Précision des nombres flottants.
// En WebGL, même highp reste généralement proche du float32 GPU.
precision highp float;

// Résolution réelle du canvas en pixels.
uniform vec2 u_resolution;

// Centre de la caméra dans le plan complexe.
uniform vec2 u_center;

// Taille verticale visible dans le plan complexe.
// Plus cette valeur est petite, plus on zoome.
uniform float u_scale;

// Paramètre complexe c de l'ensemble de Julia.
// Formule : z = z² + c.
uniform vec2 u_c;

// Nombre maximum d'itérations.
uniform int u_maxIter;

// Couleur finale du pixel.
out vec4 outColor;

// Palette de couleur simple.
// t est une valeur entre 0 et 1.
vec3 palette(float t) {
  // cos donne une transition douce entre les couleurs.
  return 0.5 + 0.5 * cos(6.28318 * (vec3(0.00, 0.33, 0.67) + t));
}

void main() {
  // Position du pixel courant en pixels.
  vec2 pixel = gl_FragCoord.xy;

  // Coordonnées normalisées :
  // uv.x = 0 à gauche, 1 à droite.
  // uv.y = 0 en bas, 1 en haut.
  vec2 uv = pixel / u_resolution;

  // On recentre autour de 0.
  // p est environ entre -0.5 et 0.5.
  vec2 p = uv - 0.5;

  // Correction du ratio largeur/hauteur.
  // Sans ça, la fractale serait déformée sur un écran non carré.
  p.x *= u_resolution.x / u_resolution.y;

  // Conversion écran -> plan complexe.
  // z est le point de départ du pixel dans le plan complexe.
  vec2 z = u_center + p * u_scale;

  // Nombre d'itérations avant divergence.
  int iter = 0;

  // Boucle d'itération.
  // La limite 2000 doit être constante pour rester compatible WebGL.
  for (int i = 0; i < 2000; i++) {
    // Si on atteint le nombre d'itérations demandé, on arrête.
    if (i >= u_maxIter) {
      iter = u_maxIter;
      break;
    }

    // Calcul de z² + c.
    // Si z = x + iy :
    // z² = (x² - y²) + i(2xy)
    float x = z.x * z.x - z.y * z.y + u_c.x;
    float y = 2.0 * z.x * z.y + u_c.y;

    // Mise à jour de z.
    z = vec2(x, y);

    // Test de divergence.
    // dot(z, z) = |z|².
    // Si |z|² > 4, alors |z| > 2, donc le point diverge.
    if (dot(z, z) > 4.0) {
      iter = i;
      break;
    }
  }

  // Si le point ne diverge pas avant u_maxIter,
  // on le considère comme appartenant à l'ensemble et on le met en noir.
  if (iter == u_maxIter) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Normalisation du nombre d'itérations entre 0 et 1.
  float t = float(iter) / float(u_maxIter);

  // Calcul de la couleur.
  vec3 color = palette(t);

  // Couleur finale du pixel.
  outColor = vec4(color, 1.0);
}
`;

// Compile un shader GLSL.
// type vaut gl.VERTEX_SHADER ou gl.FRAGMENT_SHADER.
function createShader(
    gl: WebGL2RenderingContext,
    type: number,
    source: string,
): WebGLShader {
    // Crée un objet shader vide.
    const shader = gl.createShader(type);

    // Vérifie que la création a réussi.
    if (!shader) {
        throw new Error("Failed to create shader");
    }

    // Envoie le code GLSL au shader.
    gl.shaderSource(shader, source);

    // Compile le shader pour le GPU.
    gl.compileShader(shader);

    // Vérifie si la compilation a réussi.
    const success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);

    // Si compilation échouée, on récupère le message d'erreur.
    if (!success) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
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

    // Vérifie que la création a réussi.
    if (!program) {
        throw new Error("Failed to create WebGL program");
    }

    // Attache le vertex shader au programme.
    gl.attachShader(program, vertexShader);

    // Attache le fragment shader au programme.
    gl.attachShader(program, fragmentShader);

    // Lie les deux shaders ensemble.
    gl.linkProgram(program);

    // Vérifie que le linking a réussi.
    const success = gl.getProgramParameter(program, gl.LINK_STATUS);

    // Si le linking échoue, on récupère le message d'erreur.
    if (!success) {
        const log = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        throw new Error(`Program linking failed:\n${log}`);
    }

    // Une fois le programme lié, on peut supprimer les shaders individuels.
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    // Renvoie le programme prêt à être utilisé.
    return program;
}

// Récupère un uniform WebGL et vérifie qu'il existe.
function getUniformLocation(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    name: string,
): WebGLUniformLocation {
    // Demande à WebGL l'emplacement du uniform dans le programme.
    const location = gl.getUniformLocation(program, name);

    // Si le uniform n'existe pas, il y a soit une erreur de nom,
    // soit le shader ne l'utilise pas vraiment.
    if (!location) {
        throw new Error(`Uniform not found: ${name}`);
    }

    // Renvoie l'emplacement utilisable avec gl.uniform...
    return location;
}

// Classe principale du renderer WebGL2.
export class WebGLRenderer {
    // Canvas HTML où on dessine.
    private readonly canvas: HTMLCanvasElement;

    // Identifiant de la frame demandée avec requestAnimationFrame.
    // null signifie qu'aucun rendu n'est actuellement programmé.
    private animationFrameId: number | null = null;

    // Contexte WebGL2, c'est l'objet principal pour parler au GPU.
    private readonly gl: WebGL2RenderingContext;

    // Programme GPU : vertex shader + fragment shader.
    private readonly program: WebGLProgram;

    // Emplacement du uniform u_resolution.
    private readonly resolutionLocation: WebGLUniformLocation;

    // Emplacement du uniform u_center.
    private readonly centerLocation: WebGLUniformLocation;

    // Emplacement du uniform u_scale.
    private readonly scaleLocation: WebGLUniformLocation;

    // Emplacement du uniform u_c.
    private readonly cLocation: WebGLUniformLocation;

    // Emplacement du uniform u_maxIter.
    private readonly maxIterLocation: WebGLUniformLocation;

    // Centre de la vue dans le plan complexe, partie réelle.
    private centerX = 0.0;

    // Centre de la vue dans le plan complexe, partie imaginaire.
    private centerY = 0.0;

    // Indique si l'utilisateur est en train de faire un drag souris.
    private isDragging = false;

    // Dernière position X connue de la souris pendant le drag, en pixels écran.
    private lastMouseX = 0;

    // Dernière position Y connue de la souris pendant le drag, en pixels écran.
    private lastMouseY = 0;

    // Taille verticale visible dans le plan complexe.
    // 3.0 donne une vue large au départ.
    private scale = 3.0;

    // Partie réelle du paramètre c de Julia.
    private cRe = -0.8;

    // Partie imaginaire du paramètre c de Julia.
    private cIm = 0.156;

    // Nombre maximum d'itérations.
    private maxIter = 500;

    // Constructeur : prépare WebGL, les shaders et les buffers.
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

        // Récupère l'emplacement de l'attribut a_position dans le vertex shader.
        const positionLocation = gl.getAttribLocation(this.program, "a_position");

        // Si -1, l'attribut n'existe pas ou n'est pas utilisé.
        if (positionLocation === -1) {
            throw new Error("Attribute not found: a_position");
        }

        // Crée un buffer GPU pour les positions des sommets.
        const positionBuffer = gl.createBuffer();

        // Vérifie que le buffer a été créé.
        if (!positionBuffer) {
            throw new Error("Failed to create position buffer");
        }

        // Définit ce buffer comme buffer actif de type ARRAY_BUFFER.
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);

        // Positions de 6 sommets formant 2 triangles plein écran.
        // Coordonnées WebGL :
        // -1,-1 = bas gauche
        //  1,-1 = bas droite
        // -1, 1 = haut gauche
        //  1, 1 = haut droite
        const positions = new Float32Array([
            -1, -1,
            1, -1,
            -1, 1,

            -1, 1,
            1, -1,
            1, 1,
        ]);

        // Envoie les positions dans le buffer GPU.
        // STATIC_DRAW signifie que ces données ne changeront presque jamais.
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

        // Crée un VAO.
        // VAO = Vertex Array Object.
        // Il mémorise comment lire les buffers de sommets.
        const vao = gl.createVertexArray();

        // Vérifie que le VAO a été créé.
        if (!vao) {
            throw new Error("Failed to create vertex array object");
        }

        // Active le VAO.
        gl.bindVertexArray(vao);

        // Active l'attribut a_position.
        gl.enableVertexAttribArray(positionLocation);

        // Explique à WebGL comment lire le buffer :
        // - chaque sommet contient 2 nombres
        // - chaque nombre est un float
        // - pas de normalisation
        // - stride 0 : données compactes
        // - offset 0 : commencer au début du buffer
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

        // Récupère tous les uniforms nécessaires au shader.
        this.resolutionLocation = getUniformLocation(gl, this.program, "u_resolution");
        this.centerLocation = getUniformLocation(gl, this.program, "u_center");
        this.scaleLocation = getUniformLocation(gl, this.program, "u_scale");
        this.cLocation = getUniformLocation(gl, this.program, "u_c");
        this.maxIterLocation = getUniformLocation(gl, this.program, "u_maxIter");

        // On connecte les événements souris au canvas.
        // Pour l'instant, on ne gère que le zoom avec la molette.
        this.setupControls();

        // Si la fenêtre change de taille, il faut redessiner avec la nouvelle résolution.
        window.addEventListener("resize", () => {
            this.requestRender();
        });
    }


    // Configure les contrôles utilisateur.
    // Pour l'instant : zoom molette + déplacement souris.
    private setupControls(): void {
        // Événement molette : zoom centré au milieu de l'écran.
        this.canvas.addEventListener("wheel", (event: WheelEvent) => {
            // Empêche le scroll de la page.
            event.preventDefault();

            // Facteur de zoom.
            const zoomFactor = 0.9;

            // Molette vers le haut : zoom in.
            if (event.deltaY < 0) {
                this.scale *= zoomFactor;
            } else {
                // Molette vers le bas : zoom out.
                this.scale /= zoomFactor;
            }

            // Limite inférieure provisoire.
            this.scale = Math.max(this.scale, 1e-8);

            // Limite supérieure provisoire.
            this.scale = Math.min(this.scale, 100.0);

            // Le zoom a changé, donc l'image doit être recalculée.
            this.requestRender();
        });

        // Événement mousedown : l'utilisateur commence à déplacer la vue.
        this.canvas.addEventListener("mousedown", (event: MouseEvent) => {
            // On ne réagit qu'au clic gauche.
            // button === 0 signifie bouton gauche.
            if (event.button !== 0) {
                return;
            }

            // On active le mode drag.
            this.isDragging = true;

            // On mémorise la position initiale de la souris.
            this.lastMouseX = event.clientX;
            this.lastMouseY = event.clientY;
        });

        // Événement mousemove : la souris bouge.
        window.addEventListener("mousemove", (event: MouseEvent) => {
            // Si on n'est pas en train de drag, on ne fait rien.
            if (!this.isDragging) {
                return;
            }

            // Déplacement horizontal de la souris en pixels.
            const deltaX = event.clientX - this.lastMouseX;

            // Déplacement vertical de la souris en pixels.
            const deltaY = event.clientY - this.lastMouseY;

            // On met à jour la dernière position connue.
            this.lastMouseX = event.clientX;
            this.lastMouseY = event.clientY;

            // Taille du canvas en pixels CSS, pas en pixels GPU.
            const width = this.canvas.clientWidth;
            const height = this.canvas.clientHeight;

            // Ratio largeur / hauteur.
            // On l'utilise parce que dans le shader on corrige aussi l'aspect ratio.
            const aspect = width / height;

            // Conversion pixels écran -> unités du plan complexe.
            // Verticalement, la hauteur visible vaut this.scale.
            const complexDeltaY = (deltaY / height) * this.scale;

            // Horizontalement, la largeur visible vaut this.scale * aspect.
            const complexDeltaX = (deltaX / width) * this.scale * aspect;

            // Quand on tire l'image vers la droite, on veut voir la zone de gauche.
            // Donc le centre se déplace dans le sens opposé du mouvement souris.
            this.centerX -= complexDeltaX;

            // Attention : dans l'écran, Y augmente vers le bas.
            // Dans le plan complexe, Y augmente vers le haut.
            // Donc le signe est inversé.
            this.centerY += complexDeltaY;

            // Le centre de la vue a changé, donc l'image doit être recalculée.
            this.requestRender();
        });

        // Événement mouseup : l'utilisateur relâche le clic.
        window.addEventListener("mouseup", () => {
            // On désactive le mode drag.
            this.isDragging = false;
        });

        // Si la souris quitte la fenêtre, on arrête aussi le drag.
        window.addEventListener("blur", () => {
            // Évite de rester bloqué en mode drag si la fenêtre perd le focus.
            this.isDragging = false;
        });
    }

    // Demande un rendu à la prochaine frame navigateur.
    // Si un rendu est déjà prévu, on n'en programme pas un deuxième.
    public requestRender(): void {
        // Si une frame est déjà programmée, inutile d'en demander une autre.
        if (this.animationFrameId !== null) {
            return;
        }

        // On demande au navigateur d'appeler le rendu à la prochaine frame.
        this.animationFrameId = requestAnimationFrame(() => {
            // La frame programmée est maintenant consommée.
            this.animationFrameId = null;

            // On dessine l'image.
            this.render();
        });
    }
    // Fonction appelée à chaque frame par main.ts.
    private render(): void {
        // Ajuste la taille réelle du canvas si nécessaire.
        this.resizeCanvasIfNeeded();

        // Raccourci local vers le contexte WebGL2.
        const gl = this.gl;

        // Dit à WebGL d'utiliser notre programme GPU.
        gl.useProgram(this.program);

        // Envoie la résolution réelle du canvas au shader.
        gl.uniform2f(this.resolutionLocation, this.canvas.width, this.canvas.height);

        // Envoie le centre de la caméra au shader.
        gl.uniform2f(this.centerLocation, this.centerX, this.centerY);

        // Envoie le niveau de zoom au shader.
        gl.uniform1f(this.scaleLocation, this.scale);

        // Envoie le paramètre complexe c au shader.
        gl.uniform2f(this.cLocation, this.cRe, this.cIm);

        // Envoie le nombre maximum d'itérations au shader.
        gl.uniform1i(this.maxIterLocation, this.maxIter);

        // Dessine les 6 sommets.
        // Ces 6 sommets forment deux triangles plein écran.
        // Le fragment shader sera exécuté pour chaque pixel couvert.
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // Ajuste la résolution interne du canvas.
    private resizeCanvasIfNeeded(): void {
        // Prend en compte les écrans haute densité.
        const pixelRatio = window.devicePixelRatio || 1;

        // Largeur réelle nécessaire en pixels.
        const width = Math.floor(this.canvas.clientWidth * pixelRatio);

        // Hauteur réelle nécessaire en pixels.
        const height = Math.floor(this.canvas.clientHeight * pixelRatio);

        // Si la taille est déjà correcte, on ne change rien.
        if (this.canvas.width === width && this.canvas.height === height) {
            return;
        }

        // Met à jour la largeur interne du canvas.
        this.canvas.width = width;

        // Met à jour la hauteur interne du canvas.
        this.canvas.height = height;

        // Dit à WebGL d'utiliser toute la surface du canvas.
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
}