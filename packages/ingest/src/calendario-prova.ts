/**
 * CALENDARI FINTI CHE STANNO DENTRO LA FINESTRA GIUSTA, A QUALUNQUE ORA.
 *
 * Sta qui, accanto alla logica delle finestre che rispecchia, per una ragione
 * imparata sbagliando: lo stesso calendario finto era scritto a mano in DUE
 * verifiche, e quando si e' scoperto che era rotto ne e' stata corretta una
 * sola. La seconda ha fatto cadere la CI il giro dopo, con lo stesso messaggio.
 * Una regola duplicata non e' una regola: e' due regole che divergeranno.
 *
 * IL PROBLEMA CHE RISOLVE. La finestra della vigilia e' ancorata al GIORNO
 * LOCALE del primo fischio: apre all'ora d'uscita di quel giorno — a
 * mezzanotte se la partita e' prima, caso che in Serie A non esiste e che il
 * prodotto tratta apposta in modo conservativo. Un finto che dice «partite fra
 * due ore» eseguito alle 22:40 di Roma fabbrica una partita all'una di notte:
 * finestra che apre a mezzanotte DOMANI, quindi ancora nel futuro, e il cron
 * risponde giustamente «troppo presto». Misurato: rotto in 717 minuti su 4320,
 * cioe' un minuto su sei.
 */

import { oraLocale, istanteLocale, decidiUscita, USCITE_PREDEFINITE, type OpzioniUscite } from './calendario.js';

/**
 * L'istante oltre il quale il primo fischio cadrebbe in un altro segmento di
 * finestra: la fine del giorno locale, o l'ora d'uscita se adesso la precede.
 */
export function confineDelSegmento(
  adesso: Date, uscite: OpzioniUscite = USCITE_PREDEFINITE,
): Date {
  const qui = oraLocale(adesso, uscite.timezone);
  return qui.ora >= uscite.ora
    ? istanteLocale(qui, 23, 59, uscite.timezone)
    : istanteLocale(qui, uscite.ora - 1, 59, uscite.timezone);
}

/**
 * Un primo fischio che tiene la finestra della vigilia APERTA ADESSO.
 *
 * Resta nello stesso giorno locale di adesso, e prima dell'ora d'uscita se
 * adesso la precede. Non e' un orario di Serie A quando cade a tarda sera — e'
 * l'istante piu' tardi che tiene la finestra aperta — ma cio' che si verifica
 * con questi calendari e' il cablaggio dei due numeri, non la verosimiglianza
 * del calendario.
 */
export function primoFischioUtile(
  adesso: Date = new Date(), uscite: OpzioniUscite = USCITE_PREDEFINITE,
): Date {
  const fraDue = new Date(adesso.getTime() + 2 * 3600 * 1000);
  const confine = confineDelSegmento(adesso, uscite);
  return fraDue.getTime() < confine.getTime() ? fraDue : confine;
}

/** Il calendario di una giornata che sta per cominciare. */
export function calendarioInArrivo(
  matchday = 1, adesso: Date = new Date(),
): { matchday: number; partite: { kickoff: string }[] } {
  const primo = primoFischioUtile(adesso);
  return {
    matchday,
    partite: [
      { kickoff: primo.toISOString() },
      // La seconda partita da' una coda alla giornata: la vigilia guarda la
      // prima, il retrospettivo l'ultima.
      { kickoff: new Date(primo.getTime() + 2 * 3600 * 1000).toISOString() },
    ],
  };
}

/**
 * Nei due minuti prima di un confine la fessura e' troppo stretta perche' un
 * tick ci stia dentro: si aspetta che il confine passi. Capita al massimo una
 * volta al giorno e costa meno di due minuti, mentre una verifica che fallisce
 * due minuti su millequattrocentoquaranta e' una verifica di cui si smette di
 * fidarsi — il modo piu' caro di risparmiare due minuti.
 */
export async function attendiFinestraUtile(
  adesso: Date = new Date(), uscite: OpzioniUscite = USCITE_PREDEFINITE,
): Promise<void> {
  const margine = confineDelSegmento(adesso, uscite).getTime() - adesso.getTime();
  if (margine > 120000) return;
  console.log(`(fra ${Math.round(margine / 1000)}s cambia il segmento della vigilia: aspetto)`);
  await new Promise((ok) => setTimeout(ok, margine + 65000));
}

/**
 * La prova che il finto regge a qualunque ora: si scorrono tutti i minuti di
 * tre giorni — compresi i due del cambio d'ora, dove l'aritmetica sui fusi
 * sbaglia di un'ora intera — e si controlla che la vigilia sia dovuta in
 * ognuno. Con la versione precedente cadeva da sola.
 */
export function finestraSempreAperta(
  giorni: readonly string[] = ['2026-09-11', '2026-03-29', '2026-10-25'],
): { minuti: number; buchi: number } {
  let minuti = 0;
  let buchi = 0;
  for (const giorno of giorni) {
    for (let m = 0; m < 24 * 60; m++) {
      const adesso = new Date(`${giorno}T00:00:00Z`);
      adesso.setUTCMinutes(adesso.getUTCMinutes() + m);
      const calendario = calendarioInArrivo(1, adesso);
      const primo = Date.parse(calendario.partite[0]!.kickoff);
      // I minuti a ridosso di un confine sono quelli in cui si aspetta.
      if (primo - adesso.getTime() <= 120000) continue;
      minuti++;
      if (decidiUscita(calendario, adesso).uscita !== 'vigilia') buchi++;
    }
  }
  return { minuti, buchi };
}
