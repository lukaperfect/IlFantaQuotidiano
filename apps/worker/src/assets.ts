import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright';

/**
 * Il piano di RENDERING, separato dal piano puro.
 *
 * `@fantacomics/render` produce solo stringhe: e' testabile, veloce e senza
 * I/O. Qui vive tutto cio' che richiede un browser — e Chromium e' anche la
 * ragione per cui il worker e' un container long-running e non una funzione
 * serverless: un PDF broadsheet non sta in un timeout da qualche secondo.
 */

export type AssetOptions = {
  /** Percorso dell'eseguibile Chromium. In ambienti gestiti e' preinstallato. */
  executablePath?: string;
};

export class AssetRenderer {
  private browser: Browser | null = null;

  constructor(private readonly opts: AssetOptions = {}) {}

  private async launch(): Promise<Browser> {
    if (this.browser) return this.browser;
    const executablePath = this.opts.executablePath ?? process.env.CHROMIUM_PATH;
    this.browser = await chromium.launch(executablePath ? { executablePath } : {});
    return this.browser;
  }

  /** Il broadsheet multipagina. Una volta per edizione, poi CDN. */
  async pdf(html: string, outPath: string): Promise<string> {
    const browser = await this.launch();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      await mkdir(dirname(resolve(outPath)), { recursive: true });
      await page.pdf({
        path: outPath,
        format: 'A3',
        printBackground: true,
        margin: { top: '14mm', right: '14mm', bottom: '14mm', left: '14mm' },
      });
      return outPath;
    } finally {
      await page.close();
    }
  }

  /** Una card social. Millisecondi: e' un SVG, non una pagina. */
  async png(svg: string, outPath: string, size: { width: number; height: number }): Promise<string> {
    const browser = await this.launch();
    const page = await browser.newPage({ viewport: size, deviceScaleFactor: 2 });
    try {
      await page.setContent(
        `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0}</style>${svg}`,
        { waitUntil: 'load' },
      );
      await mkdir(dirname(resolve(outPath)), { recursive: true });
      await page.screenshot({ path: outPath });
      return outPath;
    } finally {
      await page.close();
    }
  }

  /** Anteprima della pagina web, per il QA visivo delle edizioni in revisione. */
  async screenshot(html: string, outPath: string, width = 1280): Promise<string> {
    const browser = await this.launch();
    const page = await browser.newPage({ viewport: { width, height: 1400 } });
    try {
      await page.setContent(html, { waitUntil: 'load' });
      await mkdir(dirname(resolve(outPath)), { recursive: true });
      await page.screenshot({ path: outPath, fullPage: true });
      return outPath;
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}

/** Scrive un file di testo creando le cartelle mancanti. */
export async function writeText(path: string, content: string): Promise<string> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, content, 'utf8');
  return path;
}
