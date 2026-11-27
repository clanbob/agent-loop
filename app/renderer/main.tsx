import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LucideProvider } from "lucide-react";
import { App } from "./App.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LucideProvider size={16} strokeWidth={1.5}>
      <App />
    </LucideProvider>
  </StrictMode>,
);
