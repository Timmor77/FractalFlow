// FractalFlow — renderer Julia CUDA par PERTURBATION (version native hyper-optimisée).
//
// Même algorithme que le backend WebGPU (voir src/backends/webgpu/julia.wgsl),
// mais natif et massivement parallèle :
//   - l'orbite de référence est calculée sur l'HÔTE en double-double (haute
//     précision), ce qui positionne correctement la référence en deep zoom ;
//   - chaque pixel suit son delta δ sur le GPU en double (plus précis que le f32
//     du navigateur, donc images plus propres et zoom plus profond) ;
//   - rebasing de Zhuoran pour gérer les glitches et prolonger la référence.
//
// Deux modes :
//   (défaut)  rend une image PNG pour une vue donnée ;
//   --bench   mesure le débit (GIter/s, Mpix/s) à des profondeurs de zoom croissantes.
//
// Build :  nvcc -O3 julia.cu -o julia
// Exemple : ./julia --scale 3.0 --iter 500 --w 1600 --h 1600 --out ../artifacts/cuda.png

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <cuda_runtime.h>

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

// Vérifie le code de retour d'un appel CUDA et s'arrête proprement en cas d'erreur.
#define CUDA_CHECK(call)                                                        \
  do {                                                                          \
    cudaError_t err = (call);                                                   \
    if (err != cudaSuccess) {                                                   \
      fprintf(stderr, "Erreur CUDA %s:%d: %s\n", __FILE__, __LINE__,            \
              cudaGetErrorString(err));                                         \
      exit(1);                                                                  \
    }                                                                           \
  } while (0)

// ============================================================================
// Arithmétique double-double sur l'hôte (précision de l'orbite de référence).
// Identique en esprit à src/core/doubleDouble.ts.
// ============================================================================

struct dd {
  double hi, lo;
};

static inline dd two_sum(double a, double b) {
  double s = a + b;
  double bb = s - a;
  return { s, (a - (s - bb)) + (b - bb) };
}
static inline dd quick_two_sum(double a, double b) {
  double s = a + b;
  return { s, b - (s - a) };
}
static inline dd two_prod(double a, double b) {
  double p = a * b;
  double ca = 134217729.0 * a, ah = ca - (ca - a), al = a - ah;
  double cb = 134217729.0 * b, bh = cb - (cb - b), bl = b - bh;
  return { p, ((ah * bh - p) + ah * bl + al * bh) + al * bl };
}
static inline dd dd_from(double x) { return { x, 0.0 }; }
static inline double dd_to(dd a) { return a.hi + a.lo; }
static inline dd dd_add(dd a, dd b) {
  dd s = two_sum(a.hi, b.hi);
  return quick_two_sum(s.hi, s.lo + a.lo + b.lo);
}
static inline dd dd_addd(dd a, double b) {
  dd s = two_sum(a.hi, b);
  return quick_two_sum(s.hi, s.lo + a.lo);
}
static inline dd dd_sub(dd a, dd b) { return dd_add(a, { -b.hi, -b.lo }); }
static inline dd dd_mul(dd a, dd b) {
  dd p = two_prod(a.hi, b.hi);
  return quick_two_sum(p.hi, p.lo + (a.hi * b.lo + a.lo * b.hi));
}
static inline dd dd_div(dd a, dd b) {
  // Division par correction de Newton (deux passes suffisent pour la précision DD).
  double q1 = a.hi / b.hi;
  dd r = dd_sub(a, dd_mul(b, dd_from(q1)));
  double q2 = r.hi / b.hi;
  r = dd_sub(r, dd_mul(b, dd_from(q2)));
  double q3 = r.hi / b.hi;
  dd q = quick_two_sum(q1, q2);
  return dd_addd(q, q3);
}

// Convertit une chaîne décimale (potentiellement à beaucoup de chiffres) en DD.
// Méthode exacte : on accumule TOUS les chiffres comme un entier en DD, puis on
// divise une seule fois par 10^(nombre de décimales). Évite l'erreur qu'on aurait
// en multipliant répétitivement par 0.1 (non représentable).
static dd dd_from_string(const char* s) {
  int i = 0;
  bool neg = false;
  while (s[i] == ' ') i++;
  if (s[i] == '+' || s[i] == '-') { neg = (s[i] == '-'); i++; }

  dd val = dd_from(0.0);
  int fracDigits = 0;
  bool inFrac = false;
  for (; s[i]; i++) {
    if (s[i] == '.') { inFrac = true; continue; }
    if (s[i] < '0' || s[i] > '9') break;
    val = dd_addd(dd_mul(val, dd_from(10.0)), (double)(s[i] - '0'));
    if (inFrac) fracDigits++;
  }

  dd tenPow = dd_from(1.0);
  for (int k = 0; k < fracDigits; k++) tenPow = dd_mul(tenPow, dd_from(10.0));
  val = dd_div(val, tenPow);

  if (neg) { val.hi = -val.hi; val.lo = -val.lo; }
  return val;
}

// ============================================================================
// Orbite de référence (hôte, DD). Identique à src/core/referenceOrbit.ts.
// Sortie : Zx[], Zy[] en double ; renvoie le nombre de points valides.
// ============================================================================

static int computeReference(dd cx0, dd cy0, double jcx, double jcy, int maxIter,
                            double* Zx, double* Zy) {
  dd zx = cx0, zy = cy0;
  int len = 0;
  for (int i = 0; i < maxIter; i++) {
    Zx[i] = dd_to(zx);
    Zy[i] = dd_to(zy);
    len = i + 1;

    double zf = Zx[i], zi = Zy[i];
    if (zf * zf + zi * zi > 4.0) break;

    dd zx2 = dd_mul(zx, zx);
    dd zy2 = dd_mul(zy, zy);
    dd xy = dd_mul(zx, zy);
    dd twoXy = { 2.0 * xy.hi, 2.0 * xy.lo };
    dd nx = dd_addd(dd_sub(zx2, zy2), jcx);  // Zx² - Zy² + cx
    dd ny = dd_addd(twoXy, jcy);             // 2·Zx·Zy + cy
    zx = nx;
    zy = ny;
  }
  return len;
}

// ============================================================================
// Kernel device : perturbation en double + rebasing. Un thread par pixel.
// ============================================================================

__device__ static float3 palette(float t) {
  const float TAU = 6.2831853f;
  return make_float3(0.5f + 0.5f * cosf(TAU * (0.00f + t)),
                     0.5f + 0.5f * cosf(TAU * (0.33f + t)),
                     0.5f + 0.5f * cosf(TAU * (0.67f + t)));
}

__global__ static void renderKernel(unsigned char* out, int W, int H,
                                     double scale, double aspect, int maxIter,
                                     const double* Zx, const double* Zy, int refLen) {
  int x = blockIdx.x * blockDim.x + threadIdx.x;
  int y = blockIdx.y * blockDim.y + threadIdx.y;
  if (x >= W || y >= H) return;

  // δ initial = offset du pixel par rapport au centre. y image (haut->bas) inversé.
  double uvx = (x + 0.5) / W;
  double uvy = (y + 0.5) / H;
  double dx = (uvx - 0.5) * aspect * scale;
  double dy = (0.5 - uvy) * scale;

  double Z0x = Zx[0], Z0y = Zy[0];  // départ de la référence (= centre de la vue)
  int m = 0, iter = 0;
  bool escaped = false;
  double zx = 0.0, zy = 0.0, mag2 = 0.0;

  while (iter < maxIter) {
    double Zxm = Zx[m], Zym = Zy[m];
    zx = Zxm + dx;
    zy = Zym + dy;
    mag2 = zx * zx + zy * zy;
    if (mag2 > 4.0) { escaped = true; break; }

    // δ' = 2·Z·δ + δ²
    double ndx = 2.0 * (Zxm * dx - Zym * dy) + (dx * dx - dy * dy);
    double ndy = 2.0 * (Zxm * dy + Zym * dx) + 2.0 * dx * dy;
    dx = ndx;
    dy = ndy;
    m++;
    iter++;

    // Rebasing : on repart de Z[0] quand |z - Z0| < |δ| ou en fin de référence.
    // Le nouveau delta est z - Z[0] (préserve l'invariant z = Z[m] + δ si Z0 ≠ 0).
    double fx = Zx[m] + dx - Z0x, fy = Zy[m] + dy - Z0y;
    if ((fx * fx + fy * fy) < (dx * dx + dy * dy) || m >= refLen - 1) {
      dx = fx;
      dy = fy;
      m = 0;
    }
  }

  unsigned char* px = out + (size_t)(y * W + x) * 3;
  if (!escaped) {
    px[0] = 0; px[1] = 0; px[2] = 0;
    return;
  }

  // Coloration lissée, identique aux backends navigateur.
  float nu = log2f(0.5f * log2f((float)mag2));
  float t = ((float)iter + 1.0f - nu) * 0.02f;
  float3 c = palette(t);
  px[0] = (unsigned char)fminf(255.0f, fmaxf(0.0f, c.x * 255.0f));
  px[1] = (unsigned char)fminf(255.0f, fmaxf(0.0f, c.y * 255.0f));
  px[2] = (unsigned char)fminf(255.0f, fmaxf(0.0f, c.z * 255.0f));
}

// ============================================================================
// Orchestration hôte.
// ============================================================================

// Rend une vue et renvoie le temps GPU (ms). Alloue/écrit selon les tailles données.
static float renderView(unsigned char* dOut, int W, int H, dd cx, dd cy,
                        double jcx, double jcy, double scale, int maxIter,
                        double* hZx, double* hZy, double* dZx, double* dZy) {
  int refLen = computeReference(cx, cy, jcx, jcy, maxIter, hZx, hZy);
  CUDA_CHECK(cudaMemcpy(dZx, hZx, refLen * sizeof(double), cudaMemcpyHostToDevice));
  CUDA_CHECK(cudaMemcpy(dZy, hZy, refLen * sizeof(double), cudaMemcpyHostToDevice));

  dim3 block(16, 16);
  dim3 grid((W + block.x - 1) / block.x, (H + block.y - 1) / block.y);

  cudaEvent_t t0, t1;
  CUDA_CHECK(cudaEventCreate(&t0));
  CUDA_CHECK(cudaEventCreate(&t1));
  CUDA_CHECK(cudaEventRecord(t0));
  renderKernel<<<grid, block>>>(dOut, W, H, scale, (double)W / H, maxIter, dZx, dZy, refLen);
  CUDA_CHECK(cudaEventRecord(t1));
  CUDA_CHECK(cudaEventSynchronize(t1));
  CUDA_CHECK(cudaGetLastError());

  float ms = 0.0f;
  CUDA_CHECK(cudaEventElapsedTime(&ms, t0, t1));
  cudaEventDestroy(t0);
  cudaEventDestroy(t1);
  return ms;
}

static const char* argStr(int argc, char** argv, const char* key, const char* def) {
  for (int i = 1; i < argc - 1; i++)
    if (strcmp(argv[i], key) == 0) return argv[i + 1];
  return def;
}
static double argNum(int argc, char** argv, const char* key, double def) {
  const char* s = argStr(argc, argv, key, nullptr);
  return s ? atof(s) : def;
}
static bool argFlag(int argc, char** argv, const char* key) {
  for (int i = 1; i < argc; i++)
    if (strcmp(argv[i], key) == 0) return true;
  return false;
}

// Mode benchmark : débit à des profondeurs croissantes. Écrit un CSV.
static void runBenchmark(int argc, char** argv) {
  int W = (int)argNum(argc, argv, "--w", 1920);
  int H = (int)argNum(argc, argv, "--h", 1080);
  double jcx = argNum(argc, argv, "--cre", -0.8);
  double jcy = argNum(argc, argv, "--cim", 0.156);
  // Centre de bord pour avoir des orbites longues (cas réaliste de deep zoom).
  dd cx = dd_from_string(argStr(argc, argv, "--re", "0.76"));
  dd cy = dd_from_string(argStr(argc, argv, "--im", "0.24"));

  double* hZx = (double*)malloc(sizeof(double) * 200000);
  double* hZy = (double*)malloc(sizeof(double) * 200000);
  double *dZx, *dZy;
  unsigned char* dOut;
  CUDA_CHECK(cudaMalloc(&dZx, sizeof(double) * 200000));
  CUDA_CHECK(cudaMalloc(&dZy, sizeof(double) * 200000));
  CUDA_CHECK(cudaMalloc(&dOut, (size_t)W * H * 3));

  const char* csvPath = argStr(argc, argv, "--out", "../artifacts/cuda_bench.csv");
  FILE* csv = fopen(csvPath, "w");
  if (csv) fprintf(csv, "scale,maxIter,ms,GIterPerSec,MpixPerSec\n");

  printf("Benchmark %dx%d, c=%.4f%+.4fi (RTX / CUDA)\n", W, H, jcx, jcy);
  printf("%-12s %8s %9s %11s %11s\n", "scale", "iter", "ms", "GIter/s", "Mpix/s");

  double scale = 3.0;
  for (int level = 0; level <= 24; level += 2) {
    int maxIter = 300 + level * 400;  // plus on zoome, plus il faut d'itérations
    // Chauffe (compil JIT, caches) puis mesure la moyenne de 3 rendus.
    renderView(dOut, W, H, cx, cy, jcx, jcy, scale, maxIter, hZx, hZy, dZx, dZy);
    float ms = 0.0f;
    for (int r = 0; r < 3; r++)
      ms += renderView(dOut, W, H, cx, cy, jcx, jcy, scale, maxIter, hZx, hZy, dZx, dZy);
    ms /= 3.0f;

    double pixels = (double)W * H;
    double giter = (pixels * maxIter) / (ms * 1e-3) / 1e9;  // borne haute (itérations max)
    double mpix = pixels / (ms * 1e-3) / 1e6;
    printf("%-12.2e %8d %9.2f %11.2f %11.1f\n", scale, maxIter, ms, giter, mpix);
    if (csv) fprintf(csv, "%.6e,%d,%.3f,%.3f,%.1f\n", scale, maxIter, ms, giter, mpix);

    scale *= 0.1;  // un cran plus profond
  }

  if (csv) { fclose(csv); printf("CSV -> %s\n", csvPath); }
  free(hZx); free(hZy);
  cudaFree(dZx); cudaFree(dZy); cudaFree(dOut);
}

// Mode rendu : une image PNG.
static void runRender(int argc, char** argv) {
  int W = (int)argNum(argc, argv, "--w", 1600);
  int H = (int)argNum(argc, argv, "--h", 1600);
  int maxIter = (int)argNum(argc, argv, "--iter", 500);
  double jcx = argNum(argc, argv, "--cre", -0.8);
  double jcy = argNum(argc, argv, "--cim", 0.156);
  double scale = argNum(argc, argv, "--scale", 3.0);
  dd cx = dd_from_string(argStr(argc, argv, "--re", "0.0"));
  dd cy = dd_from_string(argStr(argc, argv, "--im", "0.0"));
  const char* out = argStr(argc, argv, "--out", "../artifacts/cuda.png");

  double* hZx = (double*)malloc(sizeof(double) * maxIter);
  double* hZy = (double*)malloc(sizeof(double) * maxIter);
  double *dZx, *dZy;
  unsigned char* dOut;
  CUDA_CHECK(cudaMalloc(&dZx, sizeof(double) * maxIter));
  CUDA_CHECK(cudaMalloc(&dZy, sizeof(double) * maxIter));
  CUDA_CHECK(cudaMalloc(&dOut, (size_t)W * H * 3));

  float ms = renderView(dOut, W, H, cx, cy, jcx, jcy, scale, maxIter, hZx, hZy, dZx, dZy);

  unsigned char* hOut = (unsigned char*)malloc((size_t)W * H * 3);
  CUDA_CHECK(cudaMemcpy(hOut, dOut, (size_t)W * H * 3, cudaMemcpyDeviceToHost));
  stbi_write_png(out, W, H, 3, hOut, W * 3);

  printf("Rendu %dx%d, scale=%.3e, iter=%d en %.2f ms -> %s\n", W, H, scale, maxIter, ms, out);

  free(hZx); free(hZy); free(hOut);
  cudaFree(dZx); cudaFree(dZy); cudaFree(dOut);
}

int main(int argc, char** argv) {
  if (argFlag(argc, argv, "--bench")) {
    runBenchmark(argc, argv);
  } else {
    runRender(argc, argv);
  }
  return 0;
}
