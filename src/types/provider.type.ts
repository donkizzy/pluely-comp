export interface TYPE_PROVIDER {
  id?: string;
  streaming?: boolean;
  // Speech providers only: live WebSocket transcription handled in Rust.
  realtime?: "deepgram" | "assemblyai";
  responseContentPath?: string;
  isCustom?: boolean;
  curl: string;
}
