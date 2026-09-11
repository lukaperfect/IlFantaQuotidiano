import type { EditionKind, FactType, Polarity, Slot } from '@fantacomics/core';

/**
 * Il mazzo dei format.
 *
 * Il rischio numero uno del prodotto non è l'allucinazione: è la NOIA alla
 * quinta giornata. Un'estrazione casuale ripete; un mazzo con cooldown no.
 * L'estrazione è seedata su (lega, giornata), quindi la varietà è garantita
 * e riproducibile invece che affidata al caso.
 */
export type FormatCard = {
  id: string;
  label: string;
  /** Istruzione di formato che finisce nel prompt. Descrive la FORMA, non il tono. */
  brief: string;
  slots: Slot[];
  /** Polarità per cui il format funziona. Un necrologio su un trionfo non fa ridere. */
  polarities: Polarity[];
  minFacts: number;
  maxFacts: number;
  /** Giornate prima che il format possa tornare. */
  cooldown: number;
  /**
   * IN QUALI EDIZIONI HA SENSO. Campo OBBLIGATORIO, e il fatto che lo sia e'
   * la decisione: un campo facoltativo con un default avrebbe lasciato che il
   * prossimo format entrasse nel mazzo senza che nessuno scegliesse, e il modo
   * in cui si sbaglia qui e' silenzioso — esce un necrologio per una squadra
   * che non ha ancora giocato, nessun test si accorge di niente, e la pagina
   * e' assurda solo per chi la legge.
   *
   * Il tempo verbale non e' deducibile dalla polarita', ed e' per questo che
   * serve un campo a parte: una tragedia si puo' raccontare prima («arriva con
   * quattro sconfitte di fila») o dopo («ha perso per mezzo punto»), e la
   * forma del pezzo che regge le due cose non e' la stessa.
   */
  edizioni: readonly EditionKind[];
  /**
   * I TIPI DI FATTO CHE QUESTO FORMAT PRETENDE COME ANCORA.
   *
   * Quasi nessun format ne ha bisogno: la polarita' basta a dire se la forma
   * regge il contenuto. Serve quando la forma PROMETTE un contenuto preciso.
   * «La sfida di giornata» parla di due squadre che si incontrano: dato un
   * fatto d'asta e nessun accoppiamento, scriverebbe di uno scontro che non ha.
   * Misurato: alla prima giornata senza calendario apriva il giornale con un
   * solo fatto d'asta e il compito di presentare una partita.
   */
  richiedeAncora?: readonly FactType[];
};

/** Solo per leggibilita' qui sotto: la stragrande maggioranza e' retrospettiva. */
const RETRO: readonly EditionKind[] = ['giornale'];
const ENTRAMBE: readonly EditionKind[] = ['giornale', 'anteprima'];
const VIGILIA: readonly EditionKind[] = ['anteprima'];

export const FORMAT_DECK: FormatCard[] = [
  {
    id: 'apertura_drammatica',
    label: 'Apertura di prima pagina',
    brief: 'Pezzo di apertura: titolo forte, occhiello, tre o quattro paragrafi di cronaca con una citazione estratta in evidenza.',
    slots: ['apertura'], polarities: ['tragedia', 'ingiustizia', 'trionfo', 'farsa'],
    minFacts: 2, maxFacts: 4, cooldown: 0,
    edizioni: RETRO,
  },
  {
    id: 'intervista_impossibile',
    label: 'Intervista impossibile',
    brief: 'Intervista inventata al presidente coinvolto: domande brevi e impietose, risposte evasive e progressivamente disperate.',
    slots: ['apertura', 'interno'], polarities: ['tragedia', 'farsa', 'ingiustizia'],
    minFacts: 1, maxFacts: 3, cooldown: 3,
    edizioni: ENTRAMBE,
  },
  {
    id: 'necrologio',
    label: 'Necrologio',
    brief: 'Necrologio funebre per una squadra o per una speranza di classifica: formule di rito, orario delle esequie, ringraziamenti.',
    slots: ['spalla', 'interno'], polarities: ['tragedia'],
    minFacts: 1, maxFacts: 2, cooldown: 6,
    edizioni: RETRO,
  },
  {
    id: 'verbale_carabinieri',
    label: 'Verbale di denuncia',
    brief: 'Verbale burocratico di denuncia per abbandono di giocatore in panchina: articoli di legge inventati, linguaggio da caserma.',
    slots: ['interno', 'rubrica'], polarities: ['farsa', 'tragedia'],
    minFacts: 1, maxFacts: 2, cooldown: 5,
    edizioni: RETRO,
  },
  {
    id: 'oroscopo',
    label: 'Oroscopo della giornata',
    brief: 'Oroscopo con una riga per ciascun presidente citato: previsione assurda ma coerente con i suoi numeri.',
    slots: ['rubrica'], polarities: ['farsa', 'mediocrita', 'trionfo'],
    minFacts: 3, maxFacts: 8, cooldown: 4,
    edizioni: ENTRAMBE,
  },
  {
    id: 'lettera_al_direttore',
    label: 'Lettera al direttore',
    brief: 'Lettera indignata di un presidente al direttore del giornale, con replica secca e sarcastica della redazione.',
    slots: ['spalla', 'interno'], polarities: ['ingiustizia', 'farsa'],
    minFacts: 1, maxFacts: 2, cooldown: 4,
    edizioni: ENTRAMBE,
  },
  {
    id: 'bollettino_medico',
    label: 'Bollettino medico',
    brief: 'Bollettino clinico sullo stato di salute delle squadre: diagnosi, prognosi, terapia consigliata.',
    slots: ['interno', 'rubrica'], polarities: ['tragedia', 'mediocrita'],
    minFacts: 2, maxFacts: 5, cooldown: 5,
    edizioni: ENTRAMBE,
  },
  {
    id: 'processo_del_lunedi',
    label: 'Il processo del lunedì',
    brief: 'Dibattito televisivo: tre voci che si accusano a vicenda sulle scelte di formazione, con un conduttore che non riesce a moderare.',
    slots: ['interno'], polarities: ['farsa', 'ingiustizia'],
    minFacts: 2, maxFacts: 4, cooldown: 4,
    edizioni: RETRO,
  },
  {
    id: 'dispaccio_di_guerra',
    label: 'Dispaccio dal fronte',
    brief: 'Cronaca di guerra dal fronte della giornata: tono epico applicato a fatti minuscoli.',
    slots: ['apertura', 'interno'], polarities: ['trionfo', 'tragedia'],
    minFacts: 2, maxFacts: 4, cooldown: 5,
    edizioni: RETRO,
  },
  {
    id: 'referto_arbitrale',
    label: 'Referto arbitrale',
    brief: 'Referto ufficiale in cui il modificatore o il regolamento vengono trattati come un arbitro parziale da deferire.',
    slots: ['spalla', 'interno'], polarities: ['ingiustizia', 'farsa'],
    minFacts: 1, maxFacts: 3, cooldown: 5,
    edizioni: RETRO,
  },
  {
    id: 'pagelle_presidenti',
    label: 'Pagelle ai presidenti',
    brief: 'Pagelle con voto e giudizio di una riga per ciascun presidente citato. Voti da 3 a 8, mai tutti uguali.',
    slots: ['rubrica', 'interno'], polarities: ['farsa', 'mediocrita', 'trionfo', 'tragedia'],
    minFacts: 3, maxFacts: 8, cooldown: 3,
    edizioni: ENTRAMBE,
  },
  {
    id: 'cronaca_nera',
    label: 'Cronaca nera',
    brief: 'Il flop di giornata raccontato come fatto di cronaca nera, con testimoni oculari e ipotesi investigative.',
    slots: ['interno'], polarities: ['tragedia', 'farsa'],
    minFacts: 1, maxFacts: 3, cooldown: 5,
    edizioni: RETRO,
  },
  {
    id: 'annunci_economici',
    label: 'Annunci economici',
    brief: 'Piccoli annunci: cerco attaccante che segni, vendo panchina inutilizzata, cedo modificatore mai arrivato.',
    slots: ['rubrica'], polarities: ['farsa', 'mediocrita'],
    minFacts: 3, maxFacts: 6, cooldown: 5,
    edizioni: ENTRAMBE,
  },
  {
    id: 'previsioni_meteo',
    label: 'Previsioni del tempo',
    brief: 'Bollettino meteo metaforico per ciascuna squadra citata: sereno, nubi sparse, allerta rossa.',
    slots: ['rubrica'], polarities: ['mediocrita', 'farsa', 'trionfo'],
    minFacts: 3, maxFacts: 6, cooldown: 6,
    edizioni: ENTRAMBE,
  },
  {
    id: 'editoriale_direttore',
    label: 'Editoriale del direttore',
    brief: 'Commento di fondo firmato dal direttore: una tesi sola, difesa con i numeri a disposizione e chiusa da una frase memorabile.',
    slots: ['apertura', 'spalla'], polarities: ['ingiustizia', 'trionfo', 'farsa', 'tragedia'],
    minFacts: 2, maxFacts: 4, cooldown: 2,
    edizioni: ENTRAMBE,
  },
  {
    id: 'bugiardino',
    label: 'Foglietto illustrativo',
    brief: 'Bugiardino di una squadra come fosse un farmaco: principio attivo, posologia, effetti indesiderati, controindicazioni.',
    slots: ['interno', 'rubrica'], polarities: ['farsa', 'tragedia', 'mediocrita'],
    minFacts: 1, maxFacts: 3, cooldown: 6,
    edizioni: ENTRAMBE,
  },
  {
    id: 'epigrafe',
    label: 'Epigrafe',
    brief: 'Lapide con iscrizione per i punti lasciati in panchina: poche righe, tono solenne, data e cifra esatta.',
    slots: ['spalla', 'rubrica'], polarities: ['tragedia'],
    minFacts: 1, maxFacts: 2, cooldown: 6,
    edizioni: RETRO,
  },
  {
    id: 'listino_borsa',
    label: 'Listino di borsa',
    brief: 'Quotazioni dei presidenti in stile finanziario: titolo, variazione percentuale, commento dell analista.',
    slots: ['rubrica'], polarities: ['mediocrita', 'trionfo', 'tragedia'],
    minFacts: 3, maxFacts: 8, cooldown: 5,
    edizioni: ENTRAMBE,
  },
  {
    id: 'telecronaca',
    label: 'Telecronaca minuto per minuto',
    brief: 'Telecronaca a blocchi temporali della sfida decisiva, con il telecronista che perde progressivamente il controllo.',
    slots: ['interno'], polarities: ['trionfo', 'tragedia', 'farsa'],
    minFacts: 2, maxFacts: 4, cooldown: 4,
    edizioni: RETRO,
  },
  {
    id: 'nota_di_biasimo',
    label: 'Nota di biasimo',
    brief: 'Nota disciplinare scolastica indirizzata a un presidente, firmata dal preside, con convocazione dei genitori.',
    slots: ['spalla', 'rubrica'], polarities: ['farsa', 'tragedia'],
    minFacts: 1, maxFacts: 2, cooldown: 5,
    edizioni: ENTRAMBE,
  },
  {
    id: 'tabellino_commentato',
    label: 'Tabellino commentato',
    brief: 'Il tabellino della giornata con una postilla velenosa per ogni sfida.',
    slots: ['taglio_basso', 'interno'], polarities: ['mediocrita', 'farsa', 'trionfo', 'tragedia'],
    minFacts: 2, maxFacts: 6, cooldown: 2,
    edizioni: RETRO,
  },
  {
    id: 'lettera_dal_carcere',
    label: 'Lettera dal carcere',
    brief: 'Lettera di un giocatore rimasto in panchina, scritta come da un detenuto ingiustamente recluso.',
    slots: ['interno', 'rubrica'], polarities: ['tragedia', 'farsa'],
    minFacts: 1, maxFacts: 2, cooldown: 6,
    edizioni: RETRO,
  },
  {
    id: 'inchiesta',
    label: 'Inchiesta esclusiva',
    brief: 'Inchiesta giornalistica con fonti anonime e documenti riservati su un caso della giornata.',
    slots: ['apertura', 'interno'], polarities: ['ingiustizia', 'farsa'],
    minFacts: 2, maxFacts: 4, cooldown: 4,
    edizioni: ENTRAMBE,
  },
  {
    id: 'coccodrillo_stagionale',
    label: 'Il punto sulla stagione',
    brief: 'Bilancio sulla stagione di una squadra a partire dagli archi narrativi citati: ascesa, crollo o stagnazione.',
    slots: ['taglio_basso', 'interno'], polarities: ['tragedia', 'trionfo', 'mediocrita'],
    minFacts: 1, maxFacts: 3, cooldown: 3,
    edizioni: RETRO,
  },
  /**
   * --- NATI PER LA VIGILIA ---
   *
   * Tre carte e non una di piu': servono a coprire gli slot che i format
   * riadattati non raggiungono. L'apertura e il taglio basso erano scoperti —
   * tutte le carte di quegli slot raccontano una partita giocata — e senza
   * queste il primo numero di una lega nuova sarebbe uscito senza prima pagina.
   */
  {
    id: 'presentazione_sfida',
    label: 'La sfida di giornata',
    brief: 'Presentazione della sfida in programma: chi si incontra, cosa portano all appuntamento, una previsione secca e impegnativa. Nessun risultato: non si e ancora giocato.',
    slots: ['apertura', 'taglio_basso'], polarities: ['trionfo', 'farsa', 'mediocrita', 'ingiustizia'],
    minFacts: 1, maxFacts: 4, cooldown: 0,
    edizioni: VIGILIA,
    // Senza un accoppiamento in programma non c'e' nessuna sfida da presentare.
    richiedeAncora: [
      'SFIDA_IN_PROGRAMMA', 'SCONTRO_AL_VERTICE', 'SCONTRO_DI_CODA', 'CONTI_APERTI',
    ],
  },
  {
    id: 'griglia_di_partenza',
    label: 'Griglia di partenza',
    brief: 'Griglia in stile motori: una riga per squadra citata, in ordine, con una nota tecnica velenosa su come si presenta al via.',
    slots: ['taglio_basso', 'interno'], polarities: ['mediocrita', 'farsa', 'trionfo'],
    minFacts: 3, maxFacts: 8, cooldown: 3,
    edizioni: VIGILIA,
  },
  {
    /**
     * La colonna di spalla della vigilia era troppo corta: tre carte in tutto,
     * e appena l'editoriale finiva in apertura ne restavano due. Misurato, il
     * piano segnalava «nessun format disponibile senza forzare cooldown o
     * polarita'» su ogni numero — cioe' il giornale ripiegava sempre, e il
     * ripiego smette di essere un segnale quando e' la norma.
     */
    id: 'parere_dell_esperto',
    label: 'Il parere dell esperto',
    brief: 'Colonna breve firmata da un esperto che sentenzia su un solo punto, con una previsione netta e la sicurezza di chi non verra mai smentito.',
    slots: ['spalla', 'interno'], polarities: ['trionfo', 'tragedia', 'farsa', 'mediocrita', 'ingiustizia'],
    minFacts: 1, maxFacts: 3, cooldown: 2,
    edizioni: VIGILIA,
  },
  {
    id: 'catalogo_d_asta',
    label: 'Catalogo d asta',
    brief: 'Schede da catalogo di casa d aste per i colpi di mercato citati: lotto, descrizione compiaciuta, stima e una postilla dell esperto che non ci crede.',
    slots: ['interno', 'rubrica'], polarities: ['trionfo', 'farsa', 'mediocrita'],
    minFacts: 2, maxFacts: 6, cooldown: 3,
    edizioni: VIGILIA,
  },
];

export const FORMATS_BY_ID = new Map(FORMAT_DECK.map((f) => [f.id, f]));

/** Il mazzo utilizzabile per un tipo di edizione. */
export function mazzoPer(kind: EditionKind): FormatCard[] {
  return FORMAT_DECK.filter((f) => f.edizioni.includes(kind));
}
