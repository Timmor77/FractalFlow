// Orbite de référence pour la théorie de la perturbation.
//
// Idée du deep zoom : au lieu d'itérer z = z² + c pour chaque pixel avec une
// précision énorme (coûteux), on itère UNE fois l'orbite du centre de la vue en
// haute précision (double-double, ~31 chiffres), puis chaque pixel ne suit qu'un
// petit écart "delta" par rapport à cette référence, en float32 sur le GPU.
//
// Pour Julia, c est constant, donc l'orbite de référence est simplement :
//   Z_0 = centre de la vue
//   Z_{n+1} = Z_n² + c
//
// On stocke chaque Z_n en float32 (partie réelle puis imaginaire) : c'est ce que
// le shader lit. La haute précision ne sert qu'à POSITIONNER correctement la
// référence ; les valeurs Z_n elles-mêmes restent d'ordre 1 (l'orbite est bornée).

import type { Dd } from "./doubleDouble";
import { ddSub, ddMul, ddAddNumber } from "./doubleDouble";

export type ReferenceOrbit = {
  // Points entrelacés : [Zx0, Zy0, Zx1, Zy1, ...], prêts à envoyer au GPU.
  data: Float32Array;

  // Nombre de points réellement calculés (peut être < maxIter si l'orbite s'échappe).
  length: number;
};

// Rayon d'évasion au carré. |Z| > 2 => l'orbite diverge.
const ESCAPE_R2 = 4.0;

// Calcule l'orbite de référence du centre de la vue, en double-double.
export function computeReferenceOrbit(
  centerX: Dd,
  centerY: Dd,
  cx: number,
  cy: number,
  maxIter: number,
): ReferenceOrbit {
  const data = new Float32Array(maxIter * 2);

  // Z démarre au centre de la vue.
  let zx = centerX;
  let zy = centerY;

  let length = 0;

  for (let i = 0; i < maxIter; i++) {
    // On enregistre le point courant en float32 (l'assignation arrondit float64 -> float32).
    data[i * 2] = zx.hi + zx.lo;
    data[i * 2 + 1] = zy.hi + zy.lo;
    length = i + 1;

    // Test d'évasion : au-delà, la référence n'a plus de sens. On garde toujours
    // au moins 2 points (même si Z0 s'échappe d'emblée) : le rebasing du shader
    // lit Z[m+1] après chaque avance de δ, il lui faut donc le successeur du
    // dernier point utilisé comme référence.
    const zxF = zx.hi + zx.lo;
    const zyF = zy.hi + zy.lo;
    if (i > 0 && zxF * zxF + zyF * zyF > ESCAPE_R2) {
      break;
    }

    // Z_{n+1} = Z_n² + c   (arithmétique complexe en double-double)
    //   réel      = Zx² - Zy² + cx
    //   imaginaire = 2·Zx·Zy + cy
    const zx2 = ddMul(zx, zx);
    const zy2 = ddMul(zy, zy);
    const xy = ddMul(zx, zy);

    // Multiplier un DD par 2 est exact (2 est une puissance de deux).
    const twoXy = { hi: 2 * xy.hi, lo: 2 * xy.lo };

    const nextX = ddAddNumber(ddSub(zx2, zy2), cx); // Zx² - Zy² + cx
    const nextY = ddAddNumber(twoXy, cy); // 2·Zx·Zy + cy

    zx = nextX;
    zy = nextY;
  }

  return { data, length };
}
