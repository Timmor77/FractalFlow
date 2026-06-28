// On importe le CSS global du projet.
// Vite va l'injecter automatiquement dans la page.
import "./style.css";

// On importe notre classe WebGLRenderer.
// Elle contient toute la logique WebGL2.
import { WebGLRenderer } from "./renderer/webglRenderer";

// On récupère l'élément HTML principal de l'application.
// Dans index.html, Vite crée normalement <div id="app"></div>.
const app = document.querySelector<HTMLDivElement>("#app");

// Si l'élément #app n'existe pas, on arrête avec une erreur claire.
if (!app) {
  throw new Error("Element #app not found");
}

// On supprime le contenu par défaut de Vite.
app.innerHTML = "";

// On crée un canvas.
// C'est la surface où WebGL va dessiner.
const canvas = document.createElement("canvas");

// On donne un id au canvas.
// Le CSS utilise cet id pour le mettre en plein écran.
canvas.id = "fractal-canvas";

// On ajoute le canvas dans la page.
app.appendChild(canvas);

// On crée le renderer WebGL2.
// À ce moment-là, le renderer prépare le GPU, les shaders et les buffers.
const renderer = new WebGLRenderer(canvas);

// On demande un premier rendu.
// Ensuite, le renderer redessinera seulement quand quelque chose change.
renderer.requestRender();
