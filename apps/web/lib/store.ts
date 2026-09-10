import { FileLeagueStore, FileAuthStore } from '@fantacomics/pipeline';

/**
 * Istanze uniche degli store.
 *
 * Su file per ora: le stesse interfacce che in produzione implementa
 * Postgres. Il percorso e' configurabile perche' in un container effimero i
 * dati vanno su un volume, non nella working directory.
 */
const root = process.env.FANTACOMICS_DATA ?? '.data';

export const store = new FileLeagueStore(root);
export const authStore = new FileAuthStore(root);
