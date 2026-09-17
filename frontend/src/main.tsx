import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { markPainted } from "./lib/splash";

const el = document.getElementById("scp-root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // Two frames, not one: the first is scheduled before React has committed, so
  // a cover lifted on it uncovers the blank frame it exists to hide.
  requestAnimationFrame(() => requestAnimationFrame(markPainted));
}
