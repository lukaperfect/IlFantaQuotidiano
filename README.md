# FantaComics

Genera automaticamente un giornale sportivo satirico personalizzato per ogni
lega di fantacalcio, a partire dai dati ufficiali della giornata.

> **Stato**: fondamenta complete e verificate end-to-end. Il motore di calcolo,
> il fact engine, il selector editoriale, la pipeline LLM, il rendering e
> l'ingestion sono implementati e testati. Manca l'adapter verso una
> piattaforma reale, l'app web e l'infrastruttura di consegna: vedi
> [Cosa manca](#cosa-manca).

## La tesi architetturale

Il valore non sta nell'LLM. Sta in due asset che l'LLM non può produrre: un
canale di ingestion che non si rompe e non fa bannare, e un motore
deterministico che trasforma numeri in *fatti drammatici verificati*. L'LLM è
l'ultimo 15% della pipeline — il più sostituibile.

Da qui tre inversioni che governano tutto il codice:

1. **Non si scrapa per lega, si scrapa per Serie A.** Il 95% dei dati (voti,
   gol, minuti, xG) è identico per tutte le leghe: si scarica una volta per
   giornata, non una per lega. Il volume di richieste crolla di ordini di
   grandezza, e con esso il rischio di ban.
2. **L'LLM non calcola e non impagina.** Riceve fatti già numerati e
   restituisce un IR strutturato, non HTML. Zero allucinazioni numeriche, un
   solo contenuto per tre formati di output.
3. **Il regolamento è dato, non codice.** Le leghe non usano tutte lo stesso:
   hardcodare quello standard significa sbagliare i numeri in una quota enorme
   di casi e far fallire la riconciliazione a catena.

## Come si prova

```bash
pnpm install
pnpm test                                   # 149 test
pnpm demo -- --out out --giornate 6         # una stagione simulata end-to-end
pnpm demo -- --out out --giornate 4 --assets   # aggiunge PDF e PNG reali (serve Chromium)
```

La demo scrive in `out/`: `giornale.html` (web responsive),
`giornale-stampa.html` + `giornale.pdf` (broadsheet A3), una card SVG/PNG per
presidente e l'immagine di anteprima per i link.

Con `--live` e `ANTHROPIC_API_KEY` impostata usa i modelli veri invece del
driver template.

## I pacchetti

| Pacchetto | Cosa fa | Perché è separato |
|---|---|---|
| `core` | Schemi Zod: snapshot, regolamento, fatti, Document IR | È il contratto dell'Anti-Corruption Layer |
| `scoring` | Fantavoto, sostituzioni, modificatori, XI ottimale, riconciliazione | Funzioni pure, nessun I/O: testabili con golden file |
| `facts` | 41 tipi di fatto in 7 famiglie di detector | Il gate del prodotto: qui si decide se fa ridere |
| `editorial` | Selezione submodulare, mazzo dei format, memoria di lega | Decide la retention più di qualsiasi altra cosa |
| `llm` | Prefisso congelato, grounding, routing, ripiego | L'unico punto in cui il sistema non è deterministico |
| `render` | Un IR, tre uscite (web, broadsheet, card) | Puro: solo stringhe, niente browser |
| `ingest` | Adapter, collector, macchina a stati, canary | La parte che sopravvive ai redesign altrui |
| `apps/worker` | Pipeline orchestrata, persistenza, PDF/PNG | Container long-running: Chromium non sta in serverless |

## Le decisioni che contano

**Riconciliazione obbligatoria.** Il motore ricalcola i punteggi dalle
formazioni e li confronta con quelli ufficiali. Se non combaciano entro 0.01
l'edizione si degrada: si raccontano i risultati ufficiali e si spengono le
metriche controfattuali. Un numero sbagliato nel gruppo WhatsApp non è un bug,
è la fine del prodotto.

**Grounding numerico.** Ogni cifra prodotta dal modello viene estratta e
verificata contro i numeri effettivamente passati. Se sfora si riprova una
volta con la correzione esplicita, poi si ripiega sul driver template — che per
costruzione non può inventare nulla. Il giornale esce sempre; quello che non
esce mai è un numero inventato.

**Il prefisso congelato.** La guida di stile è identica per ogni lega e ogni
giornata, con breakpoint di cache a TTL un'ora. Un test verifica che non
contenga anni, date o interpolazioni: un invalidatore silenzioso non dà errori,
si vede solo dalla fattura.

**La giornata non è pronta il martedì.** La Serie A gioca il lunedì sera, ha
turni infrasettimanali e rinvii. Il cron decide *quando consegnare*; una
macchina a stati decide *quando è pronto* — partite chiuse, voti sopra soglia e
stabili su letture consecutive.

**Copertura garantita.** Se un presidente non appare mai nel giornale smette di
leggerlo. Il selector ha un vincolo duro: nessuno resta invisibile due giornate
di fila, e ognuno ha diritto a un momento di gloria ogni tanto. Simmetrico è il
tetto agli sfottò: un giornale che fa litigare la lega non viene rinnovato.

**Estetica solo tipografica.** Nessuna foto di calciatori: non è gusto ma
rischio: i diritti sulle immagini di Serie A bloccano la monetizzazione al primo
tentativo.

## Cosa manca

Per andare in produzione servono, nell'ordine:

1. **Un adapter reale** verso una piattaforma di fantacalcio, più l'estensione
   browser che ne è il collector consigliato. Il contratto e il canary ci sono;
   manca la mappatura dei campi veri.
2. **L'app web** (Next.js): onboarding lega, configurazione regolamento e
   livello di piccante, archivio edizioni.
3. **Persistenza vera**: `LeagueStore` è implementato su file; in produzione va
   su Postgres, con pgvector per la memoria semantica anti-ripetizione.
4. **Consegna**: bot Telegram per l'automazione, PWA con Web Share API per la
   condivisione su WhatsApp (l'API di WhatsApp non scrive nei gruppi: qualsiasi
   piano che lo assuma è irrealizzabile).
5. **Fonte xG** con licenza commerciale verificata.
6. **Revisione umana al 100%** per le prime settimane: è così che si costruisce
   il dataset di stile, non un ripiego.

## Licenza e dati

I dati di Serie A e delle leghe appartengono alle rispettive piattaforme. Il
collector consigliato lavora nella sessione dell'utente sui dati che l'utente ha
già diritto di vedere; l'import da file è la via sempre disponibile. Prima di
qualsiasi accesso automatizzato a una piattaforma terza vanno verificati i suoi
termini di servizio.
