// Blocking message shown when the app cannot draw at all: no usable render
// backend, or a GPU device / WebGL context lost mid-session. Without it the
// only symptom is a black or frozen canvas and a line in the console.

export function showFatalMessage(title: string, detail: string, offerReload = false): void {
  // One message at a time: a later failure replaces the earlier one.
  document.querySelector(".fatal-message")?.remove();

  const box = document.createElement("div");
  box.className = "fatal-message";
  box.setAttribute("role", "alert");

  const heading = document.createElement("div");
  heading.className = "fatal-title";
  heading.textContent = title;

  const body = document.createElement("div");
  body.textContent = detail;

  box.append(heading, body);

  if (offerReload) {
    // The view lives in the URL hash, so a reload comes back to the same place.
    const button = document.createElement("button");
    button.className = "action-button primary";
    button.textContent = "Reload";
    button.addEventListener("click", () => location.reload());
    box.appendChild(button);
  }

  document.body.appendChild(box);
}
