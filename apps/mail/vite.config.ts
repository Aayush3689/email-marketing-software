import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'query-vendor': ['@tanstack/react-query'],
          'icons-vendor': ['lucide-react'],
          'ui-vendor': ['@base-ui/react', 'sonner'],
        },
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/mail/v1': {
        target: 'http://localhost:4100',
        changeOrigin: true,
      },
    },
  },
});
