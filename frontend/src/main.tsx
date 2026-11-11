import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FleetApp } from "./fleet/FleetApp";

// One frame for every view: the shell routes the Fleet, a session's page, History, Plans, Machines and Settings itself (route.ts).
const host = document.getElementById("root");
if (!host) throw new Error("The page has no #root element.");

createRoot(host).render(
  <StrictMode>
    <FleetApp />
  </StrictMode>,
);
