/** @type {import('next').NextConfig} */
export default {
  // I pacchetti del monorepo sono TypeScript sorgente, non build: Next li
  // compila insieme all'app invece di pretendere un passo di build separato.
  transpilePackages: [
    '@fantacomics/auth',
    '@fantacomics/core',
    '@fantacomics/scoring',
    '@fantacomics/facts',
    '@fantacomics/editorial',
    '@fantacomics/llm',
    '@fantacomics/render',
    '@fantacomics/ingest',
    '@fantacomics/pipeline',
  ],
  eslint: { ignoreDuringBuilds: true },

  webpack(config) {
    /**
     * I sorgenti importano con estensione `.js` come richiede ESM su Node,
     * ma i file su disco sono `.ts`. Node e tsx risolvono da soli; webpack no.
     * Senza questo alias il build fallisce su ogni import interno dei
     * pacchetti del monorepo.
     */
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};
