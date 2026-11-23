import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./theme/ThemeContext";

if (import.meta.env.DEV) {
  // React's development build adds User Timing measures on commits. WebKit keeps
  // them for the lifetime of the document, including hours of voice UI updates.
  const timer = window.setInterval(() => performance.clearMeasures(), 60_000);
  import.meta.hot?.dispose(() => window.clearInterval(timer));
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
