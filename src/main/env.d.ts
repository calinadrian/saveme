/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MAIN_VITE_GOOGLE_CLIENT_ID?: string
  readonly MAIN_VITE_GOOGLE_CLIENT_SECRET?: string
  readonly MAIN_VITE_MICROSOFT_CLIENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
