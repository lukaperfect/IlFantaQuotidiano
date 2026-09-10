# FantaComics

Genera automaticamente un giornale sportivo satirico personalizzato per ogni
lega di fantacalcio, a partire dai dati ufficiali della giornata.

> **Stato**: prodotto funzionante end-to-end, con account, isolamento fra
> proprietari e persistenza su Postgres. Un admin accede, collega una lega,
> genera le edizioni e condivide il giornale con un link revocabile. Manca
> l'adapter verso una piattaforma reale e la consegna automatica: vedi
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
pnpm test                                   # 253 test (238 senza database)
pnpm demo -- --out out --giornate 6         # una stagione simulata end-to-end
pnpm demo -- --out out --giornate 4 --assets   # aggiunge PDF e PNG reali (serve Chromium)

# L'app web
pnpm --filter @fantacomics/web build
FANTACOMICS_SECRET="una-stringa-di-almeno-32-caratteri-davvero" \
FANTACOMICS_MAIL_LOG=./posta.log \
pnpm --filter @fantacomics/web start        # http://localhost:3000
```

L'accesso è senza password: si inserisce l'email e arriva un link valido
quindici minuti, utilizzabile una volta sola. In sviluppo il link finisce in
`FANTACOMICS_MAIL_LOG` (o sul log se non è impostata) invece di essere spedito.

### L'estensione

```bash
# 1. un portale finto che scarica i propri dati come farebbe un sito vero
pnpm --filter @fantacomics/extension portale       # http://127.0.0.1:4173

# 2. la catena completa in un browser vero, con l'estensione caricata
DATABASE_URL=... pnpm --filter @fantacomics/extension verifica
```

La verifica carica `apps/extension` in Chromium, apre il portale, arma la
cattura e controlla venti asserzioni: che a estensione **disarmata** non venga
catturato niente, che armata prenda tutte e cinque le risposte — compresa
quella via `XMLHttpRequest`, che dentro la pagina è una strada diversa da
`fetch` — che il relay accetti, che il giornale esista davvero all'indirizzo
pubblico, e che «Ferma» svuoti la memoria senza riprendere da sola.

Per installarla a mano: `chrome://extensions` → Modalità sviluppatore →
«Carica estensione non pacchettizzata» → `apps/extension`. Nel popup si
incollano l'indirizzo di FantaComics e la chiave che si genera dalla pagina
della lega.

`FANTACOMICS_SECRET` non ha un valore di ripiego in produzione: senza, l'app
**si rifiuta di partire**. Un default che funziona anche in produzione è la
vulnerabilità classica — nessuno se ne accorge finché qualcuno non forgia una
sessione.

### Persistenza

Senza `DATABASE_URL` i dati vanno su file, il che va bene per lo sviluppo e
male per un container effimero. Con `DATABASE_URL` si va su Postgres e lo
schema viene applicato all'avvio:

```bash
DATABASE_URL=postgres://utente@host:5432/fantacomics \
FANTACOMICS_SECRET=... pnpm --filter @fantacomics/web start
```

Il passaggio è una variabile d'ambiente e non un rifacimento, perché le due
implementazioni condividono una **suite di contratto**: le stesse asserzioni
girano su entrambe, e se divergono il test lo dice subito. Per eseguirla anche
sul database:

```bash
FANTACOMICS_TEST_DB=postgres://utente@host:5432/postgres pnpm test
```

Senza quella variabile i test dello store Postgres si saltano da soli. In CI un
passo dedicato **fallisce se qualcosa è stato saltato**: un contratto metà
verificato in silenzio è peggio di nessun contratto, perché sembra verde.

Nell'app: **Collega una lega → Genera la lega di prova** crea tre giornate con
dati realistici e porta direttamente al giornale. Serve a vedere il prodotto
prima di mettersi a esportare file — chiedere cinque CSV a un admin che non ha
ancora visto niente è il modo più sicuro di perderlo.

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
| `auth` | Account, magic link monouso, sessione firmata HMAC | Sicurezza isolata e testabile a parte |
| `pipeline` | Pipeline a sette step, store, configurazione lega | Condivisa tra worker e app web |
| `apps/worker` | CLI della stagione, generazione PDF/PNG | Container long-running: Chromium non sta in serverless |
| `apps/web` | Onboarding, archivio, lettura, card condivisibili | Il piano di controllo; il giornale resta un documento autonomo |
| `apps/extension` | Estensione MV3: intercetta, non scrapa | Il collector consigliato, più il portale finto che lo verifica |

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
stabili su letture consecutive. Il `tickConsegne` è il punto in cui le due
domande si incontrano: una passata sola, non un ciclo, così gira da un cron, da
una coda durabile o da un test senza cambiare una riga. Legge la giornata
globale **una volta per giornata, non una per lega** — con cinquecento leghe
sulla stessa giornata, chiederla per lega significa cinquecento richieste
identiche e un ban meritato — ed è idempotente, perché un cron che ripubblica a
ogni passata è peggio di un cron che non parte.

**Il segnale che una giornata è finita non è la quota di voti.** Sul percorso
dell'estensione non c'è un osservatore che ricontrolla a intervalli: c'è una
persona che preme «Cattura» quando le pare. Se preme di domenica sera metà
Serie A non ha giocato, e la riconciliazione non se ne accorge — i punteggi
ufficiali parziali tornano benissimo con quelli parziali ricalcolati. La prima
versione del controllo contava i titolari con un voto e chiedeva il 90%:
misurato sui dati, una giornata *completa* sta fra il 67% e l'81%, perché i
senza voto esistono e sono legittimi. Quella soglia bocciava giornate finite,
che è il modo peggiore di sbagliare. Il segnale giusto è strutturale: **una
squadra di Serie A che non ha giocato non ha nessun voto**, mentre una che ha
giocato ne ha undici. Misurato: 20 squadre su 20 a giornata completa, 10 su 20
a metà, identico su ogni seed — e non dipende da quanti senza voto ci siano,
che è proprio la quantità impossibile da calibrare senza dati veri.

**Il giornale non può ripetersi.** Il cooldown su tipi di fatto e format
impedisce di raccontare le stesse cose; una guardia sugli n-grammi impedisce di
raccontarle con le stesse parole. Ogni pezzo viene confrontato con le edizioni
recenti della lega *e* con i pezzi già accettati nella stessa edizione: se
ricalca, si riscrive citando al modello le frasi bruciate. Un pezzo ripetitivo
non fa scattare il ripiego — è noioso, non sbagliato — ma abbassa la confidenza
e finisce in revisione.

**Copertura garantita.** Se un presidente non appare mai nel giornale smette di
leggerlo. Il selector ha un vincolo duro: nessuno resta invisibile due giornate
di fila, e ognuno ha diritto a un momento di gloria ogni tanto. Simmetrico è il
tetto agli sfottò: un giornale che fa litigare la lega non viene rinnovato.

**La proprietà non si può dimenticare.** Lo store non espone alcun metodo che
restituisca una lega senza un proprietario o uno slug pubblico. Il controllo di
accesso non dipende dal fatto che ogni pagina si ricordi di farlo: non esiste
proprio il modo di leggere una lega altrui. Una lega di un altro e una lega
inesistente rispondono identicamente, perché distinguerle direbbe a un estraneo
quali id esistono.

**Un link di accesso vale per il browser che l'ha chiesto.** Il magic link
apre una sessione, quindi inoltrarlo a qualcuno significa autenticare il *suo*
browser sul *proprio* account — e da lì in poi tutto ciò che quella persona
carica finisce in un archivio che non è il suo. È una trappola particolarmente
efficace perché non ha nessuno dei segnali che rendono riconoscibile una
truffa: dominio, certificato e interfaccia sono quelli veri. Al momento della
richiesta si mette un nonce in un cookie e se ne conserva l'hash accanto al
link. Chi torna con quel cookie entra a un click, che è il caso normale. Chi
non ce l'ha non viene respinto — aprire dal telefono un link chiesto dal
desktop è legittimo e comune — ma passa da una conferma che dice a schermo *in
quale account* sta per entrare: chi l'ha chiesto riconosce il proprio
indirizzo, chi se l'è visto girare ne legge uno che non conosce. La conferma è
una server action, cioè una POST con verifica dell'origine, perché una GET che
apre una sessione si attiva seguendo un collegamento qualunque.

**Il giornale è pubblico, il link è revocabile.** La lettura senza account non è
una svista: è il ciclo di condivisione che regge il prodotto. Ma l'indirizzo è
uno slug lungo e casuale, separato dall'identità della lega e rigenerabile in un
secondo. Per questo le risposte del giornale sono `no-store`: un segreto
revocabile che resta in una cache per ore rende la revoca una bugia.

**L'estensione intercetta, non scrapa.** Legge le risposte JSON che la pagina
della piattaforma ha *già* scaricato nella sessione dell'utente: nessuna
credenziale custodita (la password di una piattaforma terza è riusata altrove
nel 90% dei casi), nessun rischio di ban — il traffico è quello dell'utente, con
il suo IP e volumi umani — e payload che cambiano molto più lentamente del DOM.
Niente parte da solo: la cattura si arma con un gesto e l'invio con un altro, e
«Ferma» svuota davvero la memoria. Un'estensione che spedisce in sottofondo è
indistinguibile da uno spyware, quali che siano le intenzioni di chi l'ha
scritta.

**L'identità della lega viene dalla chiave, mai dal corpo.** Il relay è
autenticato da una chiave per lega, distinta dallo slug pubblico perché concede
un potere diverso: lo slug fa leggere il giornale, la chiave fa entrare dati.
L'envelope porta anche un identificatore della lega sulla piattaforma, ma è
un'etichetta diagnostica — se decidesse lui la destinazione, chiunque potrebbe
scrivere nell'archivio di chiunque cambiando una stringa.

**Il mapping sta sul server.** Quali risposte guardare e come si chiamano i
campi dentro è un dato, non codice: si corregge lato server e l'estensione lo
riceve alla riapertura. L'alternativa — ricompilare, ripubblicare, aspettare che
gli utenti aggiornino — significa saltare una o due giornate, e su un prodotto
settimanale saltare una giornata è perdere l'abitudine. Per la stessa ragione il
client non porta con sé la propria mappatura: oltre a essere manipolabile,
vanificherebbe il motivo per cui la mappatura è un dato.

**Le due sorgenti convergono sugli stessi costruttori.** CSV esportato a mano e
payload dell'estensione producono righe, e da lì in poi il codice è identico. Un
test lo dimostra: stessa giornata, stesso snapshot. Non è eleganza fine a sé
stessa — è ciò che rende vera la frase «abbiamo un percorso di riserva». Se le
due vie divergessero, il ripiego produrrebbe un prodotto diverso.

**Estetica solo tipografica.** Nessuna foto di calciatori: non è gusto ma
rischio: i diritti sulle immagini di Serie A bloccano la monetizzazione al primo
tentativo.

## Cosa manca

Per andare in produzione servono, nell'ordine:

1. **I nomi dei campi veri.** L'estensione esiste, è verificata in un browser
   contro un portale di prova che scarica i propri dati come farebbe un sito
   vero, e la catena regge tutta: intercettazione (`fetch` e `XMLHttpRequest`),
   mappatura, relay autenticato, giornale pubblicato. Quello che manca è un
   solo profilo di piattaforma — quali URL guardare e come si chiamano i campi
   dentro — che è esattamente la parte progettata per essere un dato
   aggiornabile lato server. Si compila osservando le risposte reali una volta.
2. **Un provider di posta vero**: il `Mailer` è un'interfaccia con
   implementazioni su console e su file. Serve collegarci un servizio prima di
   far accedere qualcuno che non sia sulla stessa macchina.
3. **Consegna**: bot Telegram per l'automazione, PWA con Web Share API per la
   condivisione su WhatsApp (l'API di WhatsApp non scrive nei gruppi: qualsiasi
   piano che lo assuma è irrealizzabile).
4. **Fonte xG** con licenza commerciale verificata.
5. **Revisione umana al 100%** per le prime settimane: è così che si costruisce
   il dataset di stile, non un ripiego.
6. **pgvector** per la memoria semantica anti-ripetizione: oggi il cooldown è
   per tipo di fatto e per format, non per similarità del testo generato.
7. **Il driver Anthropic contro l'API vera**: il codice c'è e l'assemblaggio
   della richiesta è testato, ma finora ha girato solo il driver template.

## Licenza e dati

I dati di Serie A e delle leghe appartengono alle rispettive piattaforme. Il
collector consigliato lavora nella sessione dell'utente sui dati che l'utente ha
già diritto di vedere; l'import da file è la via sempre disponibile. Prima di
qualsiasi accesso automatizzato a una piattaforma terza vanno verificati i suoi
termini di servizio.
