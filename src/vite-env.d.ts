/// <reference types="vite/client" />

declare module "*.css";

interface Window {
  collabWindow?: {
    close: () => void;
    confirmClose: () => void;
    cancelClose: () => void;
    minimize: () => void;
    zoom: () => void;
  };
}
