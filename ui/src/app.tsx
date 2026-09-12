import { useEffect } from "react";
import Router from "./router";
import { useStore } from "zustand";
import { appStore } from "./stores/app.store";
import TokenGate from "./components/token-gate";

export default function App() {
  return (
    <>
      <Router />
      <ThemeProvider />
      <TokenGate />
    </>
  );
}

function ThemeProvider() {
  const theme = useStore(appStore, (i) => i.theme);

  useEffect(() => {
    const html = document.documentElement;
    if (theme === "dark") {
      html.classList.add("dark");
      html.classList.remove("light");
    } else if (theme === "light") {
      html.classList.add("light");
      html.classList.remove("dark");
    }
  }, [theme]);

  return null;
}
