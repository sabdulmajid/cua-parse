import { ConversationProvider } from "@elevenlabs/react";
import App from "./App";
import "./styles.css";

export default function ResearchRoot() {
  return (
    <ConversationProvider>
      <App />
    </ConversationProvider>
  );
}
