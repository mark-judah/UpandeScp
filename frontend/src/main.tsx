import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"

const container = document.getElementById("scp-root")
if (!container) {
  throw new Error("scp-root element not found")
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
