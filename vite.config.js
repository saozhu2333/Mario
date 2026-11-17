import { defineConfig } from 'vite';

/**
 * 基础 Vite 配置
 * - base: './' 让打包产物可以放在任意子目录下直接打开（相对路径）
 * - public/img 下的参考图会原样拷贝到 dist/img
 */
export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    open: false
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // 产物按类型分目录：js 进 js/，样式进 css/，图片进 img/
        entryFileNames: 'js/[name]-[hash].js',
        chunkFileNames: 'js/[name]-[hash].js',
        assetFileNames: ({ names }) => {
          const name = names && names[0] ? names[0] : '';
          if (name.endsWith('.css')) return 'css/[name]-[hash][extname]';
          return 'img/[name]-[hash][extname]';
        }
      }
    }
  }
});
