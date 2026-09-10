import { FileLeagueStore } from '@fantacomics/pipeline';

/**
 * Istanza unica dello store.
 *
 * Su file per ora: la stessa interfaccia che in produzione implementa
 * Postgres. Il percorso e' configurabile perche' in un container effimero
 * i dati vanno su un volume, non nella working directory.
 */
export const store = new FileLeagueStore(process.env.FANTACOMICS_DATA ?? '.data');
