// Transient message at the top of the screen ("maximum depth reached",
// "export failed"): appears, stays a moment, fades out. One element, reused.

const VISIBLE_MS = 1400;

export type Toast = {
  show(message: string, durationMs?: number): void;
};

export function createToast(): Toast {
  const element = document.createElement("div");
  element.className = "toast";
  // Announced by screen readers without stealing focus.
  element.setAttribute("role", "status");
  document.body.appendChild(element);

  let timer: number | null = null;
  return {
    show(message: string, durationMs = VISIBLE_MS): void {
      element.textContent = message;
      element.classList.add("visible");
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = window.setTimeout(() => {
        element.classList.remove("visible");
        timer = null;
      }, durationMs);
    },
  };
}
