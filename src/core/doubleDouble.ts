// Arithmétique "double-double" (DD).
//
// Un nombre DD est représenté par deux float64 : hi + lo, où lo tient l'erreur
// que hi ne peut pas représenter. On obtient ainsi ~106 bits de mantisse,
// soit ~31 chiffres décimaux (contre ~16 pour un float64 seul).
//
// On l'utilise pour deux choses seulement :
//   - stocker le centre de la vue avec assez de précision pour du deep zoom ;
//   - calculer l'orbite de référence de la perturbation (voir referenceOrbit.ts).
//
// On garde donc uniquement les opérations nécessaires : add, sub, mul, plus les
// conversions. Rien de plus.

// Un nombre double-double : valeur = hi + lo, avec |lo| <= 0.5 ulp(hi).
export type Dd = {
  hi: number;
  lo: number;
};

// Crée un DD à partir d'un float64 ordinaire (lo = 0, aucune perte).
export function ddFromNumber(x: number): Dd {
  return { hi: x, lo: 0 };
}

// Reconvertit un DD en float64 (on perd la précision supplémentaire).
// Sert à l'affichage et aux calculs qui n'ont pas besoin de la précision DD.
export function ddToNumber(a: Dd): number {
  return a.hi + a.lo;
}

// Somme exacte de deux float64 : renvoie [s, e] tel que a + b = s + e exactement,
// avec s = fl(a + b). Algorithme "TwoSum" de Knuth (sans hypothèse sur |a|,|b|).
function twoSum(a: number, b: number): [number, number] {
  const s = a + b;
  const bb = s - a;
  const e = (a - (s - bb)) + (b - bb);
  return [s, e];
}

// Somme exacte rapide quand on sait déjà que |a| >= |b|. "QuickTwoSum".
function quickTwoSum(a: number, b: number): [number, number] {
  const s = a + b;
  const e = b - (s - a);
  return [s, e];
}

// Produit exact de deux float64 : renvoie [p, e] tel que a * b = p + e exactement.
// JavaScript n'a pas de FMA, on utilise donc le "TwoProduct" de Dekker avec split.
// 134217729 = 2^27 + 1, la constante de split pour une mantisse de 53 bits.
function twoProd(a: number, b: number): [number, number] {
  const p = a * b;

  const ca = 134217729 * a;
  const ahi = ca - (ca - a);
  const alo = a - ahi;

  const cb = 134217729 * b;
  const bhi = cb - (cb - b);
  const blo = b - bhi;

  const e = ((ahi * bhi - p) + ahi * blo + alo * bhi) + alo * blo;
  return [p, e];
}

// Addition DD + DD.
export function ddAdd(a: Dd, b: Dd): Dd {
  const [s, e0] = twoSum(a.hi, b.hi);
  const e = e0 + a.lo + b.lo;
  const [hi, lo] = quickTwoSum(s, e);
  return { hi, lo };
}

// Addition DD + float64 (cas fréquent : on décale le centre d'un petit delta).
export function ddAddNumber(a: Dd, b: number): Dd {
  const [s, e0] = twoSum(a.hi, b);
  const e = e0 + a.lo;
  const [hi, lo] = quickTwoSum(s, e);
  return { hi, lo };
}

// Soustraction DD - DD.
export function ddSub(a: Dd, b: Dd): Dd {
  return ddAdd(a, { hi: -b.hi, lo: -b.lo });
}

// Multiplication DD * DD.
export function ddMul(a: Dd, b: Dd): Dd {
  const [p, e0] = twoProd(a.hi, b.hi);
  const e = e0 + (a.hi * b.lo + a.lo * b.hi);
  const [hi, lo] = quickTwoSum(p, e);
  return { hi, lo };
}
