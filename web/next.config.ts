import type { NextConfig } from 'next';

/**
 * @zama-fhe/relayer-sdk (browser entry: /web) loads WASM at runtime via:
 *
 *   new URL('kms_lib_bg.wasm', import.meta.url)
 *   new URL('tfhe_bg.wasm',    import.meta.url)
 *
 * Next.js 15 + webpack 5 handles `new URL(…, import.meta.url)` natively as
 * asset/resource — no asyncWebAssembly experiment needed.
 *
 * What we DO need:
 *  1. Node.js built-in fallbacks — relayer-sdk → bigint-buffer → buffer,
 *     and keccak → node-gyp native addon, neither of which exist in a browser.
 *  2. Buffer global — bigint-buffer calls `Buffer.from/alloc` at the top
 *     level, so we inject it via ProvidePlugin.
 *  3. serverExternalPackages — skip the SDK on the server entirely; it
 *     is only ever called inside an async function guarded by `typeof window`.
 */
const nextConfig: NextConfig = {
  // Keep the Zama SDK out of the server (Node.js) bundle entirely.
  // It is only imported dynamically inside initFhevm(), which is only
  // ever called on the client side.
  serverExternalPackages: ['@zama-fhe/relayer-sdk'],

  webpack(config, { isServer }) {
    if (!isServer) {
      // ── Node.js built-in stubs for the browser bundle ────────────────────
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs:            false,
        net:           false,
        tls:           false,
        dns:           false,
        child_process: false,
        crypto:        false,
        stream:        false,
        path:          false,
        os:            false,
        http:          false,
        https:         false,
        zlib:          false,
        // Buffer is required by bigint-buffer at module init time.
        buffer:        require.resolve('buffer/'),
      };

      // ── Inject Buffer as a global ─────────────────────────────────────────
      // bigint-buffer references `Buffer` without importing it, so webpack
      // needs to provide it from the polyfill.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const webpack = require('webpack');
      config.plugins = [
        ...(config.plugins ?? []),
        new webpack.ProvidePlugin({ Buffer: ['buffer', 'Buffer'] }),
      ];
    }

    return config;
  },
};

export default nextConfig;
