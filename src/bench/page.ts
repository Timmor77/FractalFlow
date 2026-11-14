// Shared scaffolding of the two measurement pages (/?bench and /?validate):
// a plain log, download buttons, and the identity of the GPU the numbers came
// from — without which a number is not evidence of anything.

import { downloadBlob } from "../core/download";

export type ReportPage = {
  log(line: string): void;
  addDownload(label: string, filename: string, content: string): void;
};

export function createReportPage(title: string, subtitle: string): ReportPage {
  document.title = `FractalFlow — ${title}`;
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) {
    throw new Error("#app element not found");
  }
  app.innerHTML = "";
  app.className = "report-page";

  const heading = document.createElement("h1");
  heading.textContent = `FractalFlow ${title}`;
  const sub = document.createElement("div");
  sub.className = "report-subtitle";
  sub.textContent = subtitle;
  const pre = document.createElement("pre");
  const actions = document.createElement("div");
  app.append(heading, sub, pre, actions);

  return {
    log(line: string): void {
      pre.textContent += line + "\n";
    },
    addDownload(label: string, filename: string, content: string): void {
      const button = document.createElement("button");
      button.className = "action-button";
      button.textContent = label;
      button.addEventListener("click", () => {
        downloadBlob(new Blob([content], { type: "text/csv" }), filename);
      });
      actions.appendChild(button);
    },
  };
}

// Vendor / architecture / device of the WebGPU adapter, as the browser
// reports it (for example "nvidia / ampere" or "apple / metal-3").
export async function describeAdapter(): Promise<string> {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) {
    return "unknown";
  }
  const info = adapter.info;
  return [info.vendor, info.architecture, info.device, info.description]
    .filter((part) => part && part.length > 0)
    .join(" / ");
}
