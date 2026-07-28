/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_STORYOPS_ENV?: 'sandbox' | 'live';
  readonly VITE_STORYOPS_DATA_MODE?: 'sandbox' | 'supabase' | 'live';
  readonly VITE_STORYOPS_TIME_ZONE?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_STORYOPS_COMPANY_ID?: string;
  readonly VITE_INTEGRATION_HEALTH_REFRESH_SECONDS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
