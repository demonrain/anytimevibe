import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AdminApp } from "./AdminApp";
import { App } from "./App";
import { I18nProvider } from "./i18n/I18nProvider";
import "./styles.css";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(console.error));
}

const isAdminRoute = window.location.pathname === "/admin" || window.location.pathname.startsWith("/admin/");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      {isAdminRoute ? <AdminApp /> : <App />}
    </I18nProvider>
  </StrictMode>
);
