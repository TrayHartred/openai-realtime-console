import '@openai/realtime-api-beta';

declare module '@openai/realtime-api-beta' {
  interface SessionOptions {
    voice?: 'alloy' | 'shimmer' | 'echo' | 'ash';
  }
} 