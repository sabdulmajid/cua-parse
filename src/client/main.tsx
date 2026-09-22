import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import Workspace from "../workspace/Workspace";

const ResearchRoot = lazy(() => import("./ResearchRoot"));
const research = /^\/research\/?$/.test(location.pathname);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={<p role="status">Opening research…</p>}>
      {research ? (
        <ResearchRoot />
      ) : (
        <Workspace
          liveResearchHref="/research"
          mediaBase={import.meta.env.DEV ? "/showcase/assets/" : "/demo-media/"}
        />
      )}
    </Suspense>
  </React.StrictMode>,
);
