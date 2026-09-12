# FantaComics

Genera automaticamente un giornale sportivo satirico personalizzato per ogni
lega di fantacalcio, a partire dai dati ufficiali della giornata.

> **Stato**: il giro completo funziona end-to-end. Un admin accede, carica il
> file delle rose, **attiva la lega per 4,99 € una tantum** e da quel momento il
> giornale esce due volte a settimana: la *vigilia* la mattina in cui si comincia
> a giocare, il *retrospettivo* la mattina dopo l'ultima partita. Account,
> isolamento fra proprietari e persistenza su Postgres. Quel che resta e'
> configurazione e fornitori: vedi [Cosa manca](#cosa-manca).

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
pnpm test                                   # 606 test (593 senza database)
pnpm demo -- --out out --giornate 6         # una stagione simulata end-to-end
pnpm demo -- --out out --giornate 4 --assets   # aggiunge PDF A3 e un campione di card in PNG

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

**La coda di revisione è una coda, non un'etichetta.** La soglia di confidenza
esisteva da sempre: la pipeline la calcolava, la CLI la stampava, il relay la
riportava nella risposta. E poi *nessun percorso di lettura la guardava*. Un
giornale con la riconciliazione fallita rispondeva all'indirizzo pubblico
esattamente come uno buono, quindi «meglio nessun giornale che un giornale
sbagliato» era una frase senza codice sotto. Ora sotto soglia tutte e quattro le
uscite pubbliche — giornale, versione da stampa, pagina card e immagine —
rispondono **404**, lo stesso di una lega altrui: chi ha il link non deve
nemmeno sapere che esiste una bozza. Il proprietario la rivede da un indirizzo
che passa dall'id interno e dalla sessione, e decide: approvarla registra un
giudizio umano senza toccare il testo, e rigenerare la giornata azzera
l'approvazione, perché quel «va bene» riguardava quel giornale lì.

**Un motore di ricerca ha una memoria più lunga di una cache.** La promessa
«l'indirizzo è un segreto revocabile» l'ho già dovuta difendere una volta dalle
cache HTTP; i motori sono la stessa minaccia, peggiore. Basta che qualcuno
incolli il link in un forum perché nomi, punteggi e sfottò diventino cercabili
per sempre — e rigenerare lo slug a quel punto non revoca più niente, perché il
contenuto è già altrove. La mossa istintiva, `Disallow: /g/` nel `robots.txt`,
è **quella sbagliata**: `Disallow` impedisce di *scaricare* la pagina, non di
indicizzarla, e un motore che trova il link altrove può elencare l'URL lo
stesso — senza aver mai letto il `noindex` che gli stiamo chiedendo di
rispettare. La combinazione che funziona è l'opposto: `/g/` resta scaricabile, e
ogni risposta porta `X-Robots-Tag: noindex` (più il `<meta>` nel documento). I
tag OpenGraph restano: l'anteprima in chat e l'indicizzazione sono due cose
diverse, e rinunciare alla prima per ottenere la seconda spegnerebbe proprio la
feature che moltiplica la condivisione.

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

**Un file sbagliato deve dire cosa non andava.** È il modo più probabile di
fallire su questo percorso: una colonna con un altro nome, una riga senza
`playerId`, dieci titolari invece di undici. L'importatore lo sa dire con
precisione — «Riga 2 dei voti senza playerId» — e quei messaggi finivano tutti
inghiottiti da una pagina d'errore generica, lasciando come unica strategia
possibile rinunciare. Ora tornano inline sul modulo, che è dove servono.

**L'interruttore di emergenza si deve poter azionare.** Il percorso da CSV è
ciò che tiene in piedi il prodotto se la piattaforma chiude gli accessi. Ma il
modulo chiedeva cinque file senza dire una parola su quali colonne servissero:
l'unico modo di scoprirlo era leggere il codice, e un interruttore che non sai
azionare non è un interruttore. Ogni file ha ora un modello scaricabile e le
colonne scritte in pagina — **generati dallo stesso esportatore** che un test di
round-trip lega all'importatore, quindi non possono divergere da ciò che
l'importatore accetta davvero. Il test end-to-end scarica i modelli e li
rimette dentro dal modulo vero: se le due parti divergessero, lo direbbe subito.

**Estetica solo tipografica.** Nessuna foto di calciatori: non è gusto ma
rischio: i diritti sulle immagini di Serie A bloccano la monetizzazione al primo
tentativo.

## Il foglio delle rose di leghe.fantacalcio.it

Il primo formato vero che il prodotto legge, ed e' anche l'artefatto che apre
la porta: un admin lo scarica gia' fatto dalla sua lega, e da quel singolo file
escono squadre, rose complete, ruoli e prezzi d'asta. Non e' una delle tabelle
di una giornata — e' cio' che fa *esistere* la lega, una volta per stagione.

Il foglio e' disposto in orizzontale: ogni squadra occupa due colonne (nome del
giocatore, costo) piu' una di stacco, con il nome in prima riga e una riga
`totale` in fondo.

**Due difetti strutturali del formato, ed e' li' che sta il lavoro.**

*Il ruolo non e' scritto da nessuna parte: e' implicito nella posizione.* I
primi tre sono portieri, gli otto dopo difensori, poi otto centrocampisti, poi
sei attaccanti. Una riga aggiunta o tolta a meta' elenco fa scalare tutti i
ruoli sottostanti, e il file resta perfettamente valido a vedersi — il guasto
peggiore possibile: silenzioso, e capace di sbagliare ogni formazione, ogni XI
ottimale e ogni fatto che ne discende. Per questo il numero di giocatori non si
adatta a cio' che si trova, si **verifica**: se non e' 25 il file viene
rifiutato, perche' dedurre i ruoli da un elenco di lunghezza sbagliata
significa inventarli.

*Non esiste un identificatore di giocatore: solo il nome visualizzato.* La
piattaforma disambigua gli omonimi con le iniziali — «Thuram» e «Thuram K.»
sono due persone diverse, come «Adams C.» e «Adams A.», «Esposito Se.» e
«Esposito F.P.». La normalizzazione deve tenerli distinti; e siccome in
un'asta un giocatore appartiene a una squadra sola, due chiavi uguali provano
che qualcosa e' andato storto — una riga duplicata, o due nomi collassati sulla
stessa chiave. Unirli in silenzio corromperebbe due rose, quindi si rifiuta.

In compenso il formato regala un controllo d'integrita': la riga `totale`.
Sommare i costi e confrontarli coglie esattamente cio' che il conteggio delle
righe non vede — un costo corretto a mano. Le due verifiche non si
sovrappongono, ed e' per questo che ci sono entrambe.

**Il lettore non usa librerie.** Legge un file caricato da un estraneo, ed e'
la superficie d'attacco piu' larga del prodotto: duecento righe che fanno solo
quello si rileggono per intero, un albero di dipendenze transitive no. Cio' che
deve reggere non e' il file che l'utente scarica ma quello che *ricarica*:
passato da Excel o LibreOffice, le stringhe migrano da `inlineStr` a
`sharedStrings`, le voci da memorizzate a compresse, i totali diventano formule
con il valore in cache. Sono lo stesso foglio e devono dare lo stesso
risultato: sei codifiche diverse sono sotto test, e un generatore le produce
tutte.

Misurato sul file di una lega vera: 10 squadre, 250 giocatori, 250 chiavi
distinte, zero collisioni, e il `totale` che combacia su 10 blocchi su 10.

## Le due uscite della settimana

Il giornale esce due volte per giornata, e i due numeri non sono lo stesso
giornale con piu' o meno dati dentro: sono due prodotti diversi.

| | **Vigilia** (`anteprima`) | **Retrospettivo** (`giornale`) |
|---|---|---|
| Quando | la mattina in cui si comincia a giocare | la mattina dopo l'ultima partita |
| Materia | asta, calendario, classifica, storico | voti, formazioni, punteggi, rimpianti |
| Tabellino | le partite in programma, senza punteggi | i risultati |
| Card personali | nessuna | una per presidente |
| Indirizzo | `/g/<slug>/<n>/vigilia` | `/g/<slug>/<n>` |
| Mazzo dei format | 16 carte, 3 nate per la vigilia | 24 carte |

### Quando escono: dal calendario, non dal giorno della settimana

La Serie A gioca il venerdi' sera, il lunedi' sera, ha turni infrasettimanali e
rinvii. Una giornata puo' cominciare venerdi' e finire lunedi', oppure stare
tutta dentro un mercoledi'. **Un cron fissato al martedi' pubblica giornali
sbagliati con puntualita' svizzera** — ed e' esattamente la premessa che
sopravviveva nel pianificatore come «finestra di consegna».

Adesso le due uscite discendono dagli orari veri delle partite, che sono un
fatto del piano globale: uguali per tutte le leghe, letti una volta per
giornata come i voti.

- **La vigilia** apre alle 08:00 del giorno della PRIMA partita e **chiude al
  primo fischio**. Il limite superiore non e' una cortesia: un numero di
  vigilia pubblicato a partite gia' cominciate annuncia come «in programma» una
  cosa che si sta giocando. Meglio saltare un numero che stamparne uno che si
  contraddice — e il salto e' visibile nell'esito del tick, non silenzioso.
- **Il retrospettivo** apre alle 08:00 del giorno DOPO l'ultima partita e non
  chiude mai: una giornata pronta in ritardo si consegna comunque. Un
  retrospettivo che arriva tardi e' ancora un giornale; una vigilia in ritardo
  non e' piu' una vigilia.

Quella finestra dice solo «non prima di». **Chi dice «adesso» resta la macchina
a stati**: i voti devono essere stabili su due letture identiche consecutive. Le
due condizioni si sommano, e quella sui dati non e' sostituibile con un
orologio.

Senza calendario non si blocca niente: si ricade sul comportamento precedente.
Un orario mancante e' un'informazione che non abbiamo, non un divieto — se
fermasse le uscite, un fornitore che smette di pubblicarlo spegnerebbe il
prodotto per tutti senza un errore.

#### Il fuso e' la parte che si sbaglia in silenzio

«La mattina» vuol dire qualcosa solo in un fuso, e gli orari arrivano come
istanti. Due trappole, entrambe coperte da test:

1. **Una partita di lunedi' sera in ora legale e' del lunedi' a Roma e del
   lunedi' in UTC — ma un posticipo che finisce dopo le 22:00 italiane scavalca
   la mezzanotte UTC.** Contando in UTC il giornale sarebbe uscito con un
   giorno di ritardo. L'ora locale si legge con `Intl.formatToParts`, non
   formattando e riparsando una stringa: quel giro dipende dal formato di una
   locale ed e' corretto finche' qualcuno non cambia runtime.
2. **La conversione da ora da parete a istante richiede DUE passate.** Per
   sapere quale scarto UTC vale bisogna gia' sapere di che istante si parla, e
   nei giorni di cambio dell'ora la prima stima cade dal lato sbagliato.
   Misurato: con una passata sola, le 01:30 del 29 marzo davano un istante che
   a Roma sono le 00:30 — un'ora intera di errore, due volte l'anno.

### Il caso che governa il progetto

La primissima edizione che un cliente pagante vede e' una vigilia di una lega
**senza storia**: ha solo le rose appena caricate. Se la si lascia dipendere
dallo storico, quel numero esce vuoto proprio al cliente appena acquisito.

Cio' che salva quella pagina e' l'asta, perche' un'asta e' gia' una storia
completa e verificata — il file porta con se' la riga `totale` che ne fa da
somma di controllo. Misurato sul file vero di una lega da dieci squadre: **13
fatti, tutte e dieci le squadre nominate, sei pezzi**, senza una sola partita
giocata e senza calendario.

### L'asta invecchia, e deve

I fatti d'asta hanno un difetto che nessun altro fatto ha: sono gli **stessi
ogni settimana**. Martinez L. e' costato 460 crediti alla prima giornata e gli
stessi 460 alla trentesima. Con settantasei uscite a stagione, a peso pieno il
giornale ripeterebbe se stesso dalla terza — ed e' il rischio numero uno del
prodotto, non l'allucinazione: la noia. Il cooldown sul tipo di fatto non basta,
smorza per quattro giornate e poi il fatto torna identico.

Quindi il peso dei fatti d'asta decade con le giornate **giocate da quella
lega** (non con il numero della giornata: una lega iscritta a dicembre ha
l'asta come notizia fresca). Misurato, la quota d'asta in pagina:

| Giornate giocate | 0 | 0 (con calendario) | 5 | 15 |
|---|---|---|---|---|
| Quota d'asta | 100% | 81% | 40% | 37% |

A stagione avviata la notizia e' chi arriva con quattro vittorie di fila, e
«chi ha pagato 460 in agosto» e' un trafiletto.

### Il tipo fa parte della chiave dell'edizione

Le due uscite parlano della **stessa giornata**. Con la sola giornata come
chiave la seconda sovrascriveva la prima e il cliente perdeva un numero su due,
senza alcun errore: la chiave e' `(lega, giornata, tipo)` su entrambe le
implementazioni dello store, e la suite di contratto lo verifica.

Da qui una regola che vive nello store e non nel chiamante: **solo il
retrospettivo fa avanzare `lastMatchday`**. Quel campo dice al pianificatore
quale giornata consegnare la prossima volta; se la vigilia della 12 lo portasse
a 12, il retrospettivo della 12 — il numero con i risultati — non uscirebbe
mai, e il guasto sarebbe indistinguibile dal funzionamento normale.

### I format dichiarano in quale numero valgono

Il mazzo era interamente retrospettivo: «necrologio», «epigrafe per i punti
lasciati in panchina», «il processo del lunedi'», «tabellino commentato».
Un necrologio per una squadra che non ha ancora giocato non sta in piedi, e il
modo in cui si sbaglia e' silenzioso — nessun test se ne accorge, la pagina e'
assurda solo per chi la legge.

Ogni carta dichiara quindi `edizioni`, e il campo e' **obbligatorio**: un campo
facoltativo con un valore predefinito avrebbe lasciato che la prossima carta
entrasse nel mazzo senza che nessuno scegliesse. Il tempo verbale non e'
deducibile dalla polarita' — una tragedia si racconta prima («arriva con quattro
sconfitte di fila») o dopo («ha perso per mezzo punto») — ed e' per questo che
serve un campo a parte. Un test strutturale verifica che ogni slot
dell'impaginato abbia almeno una carta per ciascun tipo di numero: uno slot
scoperto non da' errore, da' un giornale senza prima pagina.

Una carta puo' anche pretendere un'**ancora** precisa. «La sfida di giornata»
promette due squadre che si incontrano: dato un fatto d'asta e nessun
accoppiamento scriverebbe di uno scontro che non ha, ed e' esattamente cosi' che
apriva il giornale prima del vincolo.

### Il budget di fatti

Un retrospettivo ha 43-48 fatti, una vigilia 13. Il selettore era tarato
sull'abbondanza: un oroscopo da otto righe estratto per il secondo slot si
mangiava il materiale dei sei pezzi successivi, che quindi non uscivano.
Misurato, il giornale usciva con **quattro pezzi su otto slot**.

Ogni pezzo ha adesso un budget — un fatto tenuto da parte per ogni slot che
resta — e il budget **restringe la scelta del format, non la decide**: fra i
format compatibili si preferiscono quelli che ci stanno, ma se nessuno ci sta si
prende comunque un compatibile. Averlo messo come filtro duro faceva perdere la
corrispondenza di polarita', cioe' produceva un necrologio su un trionfo: un
pezzo magro esce un po' asciutto, uno con la polarita' sbagliata esce
**sbagliato**.

### La direttiva al modello, e perche' non sta nel prefisso congelato

Un numero di vigilia va scritto al futuro, e il modello non lo puo' dedurre dai
fatti: un fatto d'asta e' al passato («ha pagato 460») anche quando la partita
e' domani. L'istruzione viaggia sul canale delle direttive operatore, lo stesso
del livello di piccante, e **non** nel prefisso congelato: quel prefisso e'
identico per ogni lega e ogni giornata, ed e' la ragione per cui il costo per
edizione sta dentro 4,99 euro a stagione. Due prefissi diversi significano due
voci di cache e un cold miss a ogni alternanza fra i due numeri — che e'
esattamente il ritmo del prodotto.

## La consegna automatica: i dati della giornata arrivano da soli

Il percorso da file resta, ed e' l'interruttore di emergenza. Ma un prodotto
settimanale che chiede cinque caricamenti a mano ogni lunedi' non arriva alla
terza giornata: l'abitudine si costruisce solo se il giornale compare senza che
nessuno faccia niente.

`FonteHttp` scarica i payload da un servizio e li passa alla STESSA mappatura e
agli STESSI costruttori dell'estensione e dei CSV. Non e' un modo di dire: e'
la stessa funzione, e c'e' un test che pretende snapshot **identici** dagli
stessi payload presi per le due strade. Se divergessero, lo stesso turno
darebbe due giornali diversi a seconda di come sono entrati i dati.

Cambiare fornitore e' un profilo nuovo — dati, non codice — perche' URL,
autenticazione e nomi dei campi vivono in un profilo versionato lato server,
esattamente come per l'estensione.

### I due piani hanno disponibilita' molto diverse, e confonderli fa pianificare cose che non esistono

Il piano **globale** — cosa e' successo in Serie A — e' quello per cui un
servizio ha senso: esistono fornitori che lo vendono. Attenzione pero' al voto:
il *voto* del fantacalcio non e' un dato di cronaca, e' un giudizio
redazionale di una testata. Un servizio di statistiche fornisce gli eventi, non
necessariamente il voto — e senza voto il fantavoto si puo' solo stimare, che
e' un prodotto diverso e va detto all'utente invece che scoperto da lui.

Il piano **della lega** — chi ha schierato chi questa settimana, il calendario
degli scontri — e' dato privato dentro la lega dell'utente. Nessun servizio
terzo ce l'ha, perche' non e' suo: esiste solo dietro le credenziali del
proprietario. Per quello la strada resta l'estensione, che legge nella sessione
gia' autenticata senza custodire credenziali.

Per questo `piano` e' una proprieta' di ogni **endpoint** e non della fonte
intera: un profilo puo' prendere il globale da un servizio e lasciare il piano
della lega all'estensione.

### La lettura globale e' una per giornata, non una per lega

E' l'inversione architetturale del progetto resa esecutiva: la cache vive
dentro l'oggetto fonte, quindi dieci leghe sulla stessa giornata fanno UNA
richiesta di Serie A. Su un'API a consumo e' la differenza fra un costo e un
problema. La verifica lo misura dall'interno del servizio finto — non da una
spia messa nel nostro codice: tre leghe, una lettura di `/voti`, tre di
`/formazioni`.

### Quando pubblicare: due cancelli, e il secondo non e' ridondante

Il primo e' strutturale: una squadra di Serie A che non ha giocato non ha
nessun voto. Il secondo guarda la quota di voti, e serve perche' il primo da
solo si apre troppo presto su questo percorso — i voti si pubblicano a poco a
poco, e appena ogni squadra ha il suo primo voto il cancello strutturale
passerebbe. Misurato: con il 20% dei voti distribuiti su tutte le squadre il
rapporto e' al 18% mentre tutte le squadre risultano «in campo». Uscirebbe un
giornale con nove decimi dei giocatori senza voto, e la riconciliazione non se
ne accorgerebbe, perche' punteggi parziali ufficiali tornano benissimo con
punteggi parziali ricalcolati.

Il denominatore giusto e' **chi e' sceso in campo**, non i titolari schierati:
chi ha giocato dei minuti ha un voto per definizione, mentre fra i titolari i
senza voto sono legittimi — ed e' esattamente la quantita' che avevo gia'
sbagliato a calibrare una volta. Con quel denominatore una soglia alta e'
giustificata invece che indovinata. Se un fornitore non desse i minuti il
cancello non sarebbe calcolabile: invece di restare chiuso per sempre in
silenzio, l'importatore dice quale campo manca.

In piu' servono **due letture consecutive identiche**: e' la prova che i voti
si sono fermati. Sul percorso dell'estensione non e' possibile chiederlo —
c'e' una persona che preme quando le pare — ma il cron ripassa da solo.

### Il cron

`POST /api/tick`, autenticato con un segreto. E' chiuso non perche' restituisca
dati di qualcuno, ma perche' **costa**: ogni passata interroga un servizio a
consumo e puo' far girare la pipeline su tutte le leghe collegate. Lasciato
aperto non sarebbe una fuga di dati, sarebbe una fattura. Senza segreto
configurato l'endpoint e' chiuso, non aperto.

### Scegliere un fornitore: cosa danno davvero e cosa no

**Nessuna API di statistiche sportive vende il VOTO del fantacalcio.** E' la
cosa da sapere prima di tutto, perche' cambia a cosa serve il fornitore.

Il fantavoto e' `voto + bonus/malus`. I bonus e i malus si ricavano dagli
EVENTI — gol, assist, cartellini, rigori — e quelli sono cronaca: un servizio
di statistiche li ha tutti. Il *voto* no: e' un giudizio redazionale di una
testata (Gazzetta, Corriere, Tuttosport, Fantacalcio.it), cioe' un'opinione,
non un fatto. Non lo vende un fornitore di dati perche' non e' suo.

Conseguenza concreta, e il sistema la applica gia' da solo: senza il voto i
punteggi della lega non si possono ricalcolare, la riconciliazione non
combacerebbe entro 0.01, e ogni edizione finirebbe in revisione invece di
uscire. L'architettura rifiuterebbe — correttamente — di pubblicare numeri che
non tornano.

Quindi la divisione giusta e' questa, ed e' esattamente quella che `piano`
sugli endpoint permette:

| Cosa | Da dove | Perche' |
|---|---|---|
| Voti, formazioni, calendario della lega | **Estensione** | Sono dati privati della lega dell'utente: nessun terzo li ha. Il voto lo mostra la piattaforma, che e' l'unica a saperlo |
| «La giornata e' finita?» | **API gratuita** | Una chiamata piccola con lo stato delle partite e' una risposta diretta, mentre oggi il sistema lo DEDUCE dai voti |
| Risultati e marcatori di Serie A | **API gratuita** | Alimentano il contesto del giornale, e fanno da riscontro indipendente contro una deriva della piattaforma |

Sul tetto del tier gratuito, misurato su un fine settimana di Serie A
(sabato → lunedi', posticipo compreso):

| Cron ogni | Senza rispettare l'attesa | Rispettandola |
|---|---|---|
| 5 min | 288 richieste/giorno | 30/giorno |
| 10 min | 144/giorno | 27/giorno |
| 15 min | 96/giorno | 28/giorno |

La giornata risulta pronta con **sei minuti** di differenza fra le due colonne.
Con un tetto di 100 richieste al giorno, rispettare l'attesa e' la differenza
fra funzionare e non funzionare — e `recheckAfterSeconds` esisteva gia', era
solo che non lo guardava nessuno.

Da qui la preferenza: un servizio con un limite **al minuto** invece che al
giorno e' molto piu' comodo per questo uso, perche' il costo e' una chiamata
per passata e le passate sono poche.

### Scrivere un profilo senza indovinare

I nomi dei campi sono l'unica parte di un profilo che non si puo' scrivere a
tavolino. `ispeziona-fonte.ts` si punta a un endpoint vero con la propria
chiave e dice dov'e' l'elenco dentro la risposta, che campi hanno gli elementi
e quale mappatura ne verrebbe fuori:

    pnpm exec tsx apps/worker/src/scripts/ispeziona-fonte.ts \
      --url "https://api.esempio.org/v4/competitions/SA/matches?matchday=1" \
      --header "X-Auth-Token: LA_TUA_CHIAVE"

Segnala le ambiguita' invece di scioglierle: su un payload di prova propone
`vote ← stats.voto | stats.fantavoto`, che sono due cose diverse, e lascia
scegliere. Un accoppiamento automatico su un nome somigliante e' il modo piu'
rapido di mappare il campo sbagliato senza accorgersene. La chiave non viene
mai stampata, nemmeno dentro l'URL in caso di errore.

## Leggere un sito invece di un'API

Il *voto* del fantacalcio non e' un dato di cronaca: e' il giudizio redazionale
di una testata, e non esiste un fornitore che lo venda come si vende un
risultato. Finche' non c'e' un accordo, l'unica strada e' leggere il sito che lo
pubblica — ed e' una decisione commerciale, con un rischio, presa da chi possiede
il prodotto. Il codice la rende **il meno rischiosa possibile**, non la nasconde.

### Ci si presenta

Il profilo dichiara `identificazione`, e da li' esce uno `User-Agent` con
prodotto, versione e un **contatto**:

    FantaComics/1.0 (+https://fantacomics.it/bot)

Non e' cortesia. Uno scraper anonimo e' quello che si prende il ban dell'IP e
l'escalation; uno che dice chi e' e lascia un recapito si prende, al massimo, una
mail — e una mail e' una conversazione, non una diffida. Costa un header.

### robots.txt si rispetta, e disattivarlo e' un dato scritto

`robots.txt` non e' vincolante quasi da nessuna parte, ma e' il segnale piu'
chiaro di cosa il proprietario voglia ed e' il **primo fatto citato** quando una
raccolta automatica finisce in discussione. Si legge una volta per host, si
rispetta, e il controllo sta **prima** della richiesta: dopo sarebbe inutile,
perche' la richiesta vietata l'avremmo gia' fatta e nei loro log ci sarebbe
comunque.

Il `Crawl-delay`, che non sta nella RFC ma lo scrivono in molti, e' una richiesta
esplicita di rallentare: vince sulla nostra attesa minima.

`rispettaRobots: false` esiste, sta **nel profilo** — cioe' e' un dato visibile e
versionato — e un percorso vietato produce un errore che dice cosa fare: un
accordo, un percorso diverso, o quella riga li'. Disattivarlo dev'essere una
decisione scritta da qualche parte, non un comportamento predefinito che nessuno
ha mai scelto.

### Una lettura per giornata, non una per lega

E' la tesi del progetto applicata a un sito. Dieci leghe che leggono i propri
voti sono dieci richieste allo stesso indirizzo per la stessa pagina: il modo
piu' rapido di farsi notare e bloccare. La cache del piano globale e' dentro
l'oggetto fonte, e un test lo fissa — dieci leghe, **una richiesta, nove riusi**.

Fra due richieste riuscite c'e' un freno. Il backoff dei tentativi esisteva gia'
ma riguarda i *guasti*: fra due richieste andate a buon fine non c'era niente, e
una raffica di richieste riuscite e' esattamente cio' che un sito vede come un
attacco.

### Il JSON sta dentro la pagina

Una pagina di un sito moderno e' HTML, ma i dati che mostra quasi sempre
viaggiano come JSON dentro quell'HTML: `__NEXT_DATA__`, un tag
`application/json`, un'assegnazione a una variabile globale. Chi legge la pagina
come testo conclude «non si puo' fare» mentre i dati erano li' sotto.

`estrazione: "json-in-html"` sull'endpoint li tira fuori, e `bloccoHtml` dice
**quale** blocco: il ripiego «il piu' grande» e' un'euristica, e il giorno in cui
il sito aggiunge un blob di configurazione piu' grosso l'estrazione cambierebbe
bersaglio in silenzio. Un id che non c'e' e' un errore, non un ripiego.

L'ispettore (`ispeziona-fonte.ts`) usa la **stessa** funzione: due euristiche
diverse direbbero «ho trovato» su un blocco che la fonte poi non prende. Stampa
la riga di profilo pronta da incollare.

### I profili arrivano dalla configurazione

Era una promessa scritta nei commenti e non mantenuta: `profiloFonte` conosceva
solo il servizio di prova, quindi collegare una fonte vera richiedeva comunque un
rilascio. Ora `FANTACOMICS_PROFILI_FONTE` porta un oggetto JSON da nome a
profilo, validato con lo **stesso** schema di quelli interni — e un profilo
malformato lancia all'avvio, quando qualcuno sta guardando, invece di fallire
alla prima giornata da consegnare di domenica sera.

La configurazione vince sugli incorporati. Cambiare fonte e' una variabile
d'ambiente.

### Cosa resta da fare, e perche' non posso farlo io

I **nomi dei campi** dentro le loro risposte. Inventarli produrrebbe codice che
sembra pronto e fallisce al primo dato vero, ed e' esattamente l'errore contro
cui e' costruito il resto del progetto. Si ricavano con `ispeziona-fonte.ts`
eseguito da una macchina che quel sito lo raggiunge.

Per **fantacalcio.it questo lavoro e' fatto**: il profilo `fantacalcio-it`
esiste, i suoi selettori vengono da una pagina vera e i test girano su un
ritaglio di quella pagina. Cosa resta sotto.

### Ricavarli senza avere un terminale

Serve un browser e nient'altro. `strumenti/raccogli-fonte.js` si incolla nella
console degli strumenti per sviluppatori (F12), sulla pagina dei voti, e salva
un file; quel file si porta qui e lo legge l'ispettore:

    pnpm exec tsx apps/worker/src/scripts/ispeziona-fonte.ts --file fantacomics-raccolta.json

Il raccoglitore **non analizza niente**, ed e' deliberato. Raccoglie tre cose:
il DOM *dopo* che il JavaScript della pagina ha girato — diverso dal file di
«salva pagina», dove spesso i dati non ci sono ancora —, gli indirizzi gia'
interrogati dalla pagina, e il **corpo** delle risposte alle richieste che la
pagina fa da li' in avanti. E' l'unica strada quando i dati non stanno
nell'HTML ma arrivano dopo, che e' il caso normale.

Perche' non analizzi lui: se avesse una sua euristica per scegliere «il blocco
buono», il giorno in cui diverge da quella della fonte direbbe «trovato» su
qualcosa che in produzione non si trova mai. L'analisi sta in un posto solo.

Non prende **intestazioni ne' cookie**, e svuota i valori dei campi che si
chiamano come una credenziale — `authToken`, `csrfToken`, `apiKey` — lasciando
il nome: cosi' si vede che quel campo esiste senza riceverne il contenuto.
L'elenco dei nomi e' corto e preciso apposta: la versione generosa — «tutto
cio' che contiene auth» — cancellerebbe anche `author`, e cancellare un campo
vero da un file che serve a leggere i nomi dei campi significa consegnare
un'analisi sbagliata per prudenza. Non e' una garanzia assoluta e non viene
presentata come tale, quindi l'avviso a schermo resta comunque.

`verifica-raccolta.ts` lo esercita in un Chromium vero contro un sito finto che
si comporta come quelli veri, e controlla anche cio' che **non** deve fare:
rompere la pagina di chi lo incolla — leggere il corpo di una risposta senza
clonarla la rompe davvero, e leggere `responseText` su una XHR con
`responseType: 'json'` lancia — e portarsi via un segreto. La prima versione se
lo portava via: stava nello script incorporato della pagina, non
nell'indirizzo. L'ha detto la verifica, non una rilettura del codice.

## Leggere il DOM, quando non c'e' nessun JSON

La pagina che pubblica i voti non interroga nessun endpoint: **quarantuno
richieste di rete e zero verso il proprio dominio** — sono tutte pubblicita' e
statistiche. I dati li scrive il server dentro il documento. E' il caso piu'
scomodo da leggere e il piu' comodo da consumare: **una sola GET per giornata**,
nessun formato interno che cambia senza preavviso.

`estrazione: "dom"` sull'endpoint, e i **selettori nel profilo**. Non sono
regexp: e' un motore di selettori CSS vero, e la ragione e' quella per cui
esiste tutto il resto dell'ingestione — i selettori sono un DATO, aggiornabile
senza rilascio. Con delle espressioni scritte a mano quella promessa sarebbe
falsa, perche' al primo annidamento in piu' servirebbe un programmatore.

Il linguaggio dei selettori ha solo cio' che la pagina vera ha imposto, e ogni
voce si e' guadagnata il posto:

| | perche' esiste |
|---|---|
| `gruppo` | la squadra e il risultato stanno nell'intestazione della tabella, non nella riga |
| `documento` | la giornata sta in un menu, ed e' un fatto della pagina intera |
| `indice` | tre testate votano lo stesso giocatore in tre colonne identiche |
| `da: "classe"` | il cartellino e' una classe CSS sul voto, non una colonna |
| `estrai` + `componi` | l'identificatore sta dentro un indirizzo; la data e' `05/09/2026` |
| `fuso` | «20:45» vuol dire 20:45 *a Roma* |
| `mappa` | i ruoli del sito non sono quelli canonici |
| `vuotoSe` | **`55` non e' 5,5: e' «senza voto»** |

Quell'ultima riga e' la trappola del mestiere. Cinquantasei voti valgono `55`,
e leggerli come numero darebbe un voto di cinquantacinque. La prova che e' un
segnaposto e non un mezzo punto senza virgola e' aritmetica: due giocatori
hanno `55` **e l'ammonizione**, e il loro fantavoto resta `55`, mentre in tutti
gli altri 285 casi il giallo toglie esattamente 0,5. Il malus non si applica
perche' non c'e' voto a cui applicarlo. E nessun altro mezzo punto compare mai
senza virgola: `6,5` e `7,5` sono sempre scritti per bene.

L'ordine dei passaggi e' una garanzia, non uno stile: si guarda il segnaposto
**prima** di convertire in numero. Al contrario «senza voto» diventerebbe 55, e
da li' in poi nessun controllo potrebbe piu' distinguerlo da un voto fuori
scala.

### L'indirizzo, e perche' non basta

`/voti-fantacalcio-serie-a/2026-27/4`: stagione e giornata stanno li', e quel
formato di stagione e' gia' quello che `stagioneDi` produce — due segnaposto,
nessuna conversione. La pagina risponde **senza login**.

E deve comunque **dichiarare che giornata e'**. Non e' ridondanza: un indirizzo
puo' reindirizzare — alla giornata corrente, all'ultima giocata — e chiedere la
4 ricevendo la 3 e' il difetto peggiore che questo progetto possa avere. Non
assomiglia a un guasto: i voti sarebbero coerenti, i conti tornerebbero, e il
giornale della terza racconterebbe la quarta. Nessun controllo a valle puo'
vederlo.

`campoGiornata` confronta cio' che si e' chiesto con cio' che e' arrivato, e un
disallineamento e' un errore **non riprovabile**: rileggere non cambia la
settimana, e la decisione spetta alla macchina a stati.

### Il loro robots.txt consente questa pagina

Verificato col nostro stesso parser sul loro file vero, committato in
`__fixtures__/robots-fantacalcio.txt` con un test sopra. Il gruppo `*` vieta
ricerca, preview, test e un paio d'altre cose — non i voti — e non chiede
nessuna attesa fra le richieste; il divieto totale e' per `ia_archiver`, che non
siamo noi. Il file e' li' tale e quale perche' un riassunto scritto a mano
proverebbe il parser contro l'idea che ci si e' fatti delle loro regole, e
quell'idea e' esattamente cio' che si sta verificando. Se un giorno cambiano e
chiedono un'attesa, quel test cade e l'attesa va rispettata.

### Cosa quella pagina da', e cosa no

Per 339 righe in 20 tabelle: identificatore stabile del giocatore, nome, ruolo,
squadra, **tre** voti con altrettanti fantavoti (redazione, statistico,
«Italia»), gol, gol subiti, autoreti, rigori segnati, sbagliati e parati,
assist, migliore in campo, ammonizioni, espulsioni, subentri — e in piu'
**risultato e orario** di ogni partita di Serie A, che e' cio' che decide quale
dei due numeri della settimana e' dovuto.

Non da' i **minuti giocati**. Verificato invece che sperato: non servono. Il
motore decide le sostituzioni automatiche su «senza voto», e la macchina a
stati riconosce una giornata finita dal fatto che ogni squadra scesa in campo
ha dei voti. Nessuno dei due guarda i minuti, e nel dominio `minutes` ha un
valore predefinito e zero usi.

La prova che la lettura e' giusta e non soltanto plausibile e' aritmetica:
ricalcolando il fantavoto da voto e bonus con la tabella standard — gol +3,
assist +1, rigore parato +3, autorete −2, gol subito −1, giallo −0,5, rosso −1 —
**torna su 285 giocatori su 285**.

## Termini e privacy

Ci sono, sono raggiungibili **prima di pagare** — dalla pagina d'accesso, cioe'
da prima di avere un account — e sono una **bozza di lavoro** che lo dice da
sola. Finche' `FANTACOMICS_TITOLARE`, `FANTACOMICS_PIVA`,
`FANTACOMICS_INDIRIZZO` e `FANTACOMICS_EMAIL_CONTATTO` non sono configurati, le
due pagine mostrano un avviso in testa: dei termini con dentro un segnaposto
sembrano validi a chi li legge di sfuggita, ed e' esattamente il momento in cui
non lo sono. La regola e' tutto-o-niente, e una variabile vuota vale come
assente.

Due cose vanno guardate da chi pubblica, perche' non sono scelte tecniche:

**Il recesso.** Un contenuto digitale consegnato subito fa perdere al
consumatore i quattordici giorni di ripensamento, ma solo se lo ha accettato
espressamente *prima* dell'acquisto. Quell'accettazione va raccolta nel
checkout: senza, il diritto resta — quattordici giorni su un prodotto gia'
consegnato. I termini lo dicono, il checkout non lo chiede ancora.

**I nomi dei presidenti.** Finiscono nel testo del giornale e, con una chiave
vera, passano dal fornitore del modello. Sono dati personali di persone che non
hanno un account qui: le carica l'amministratore della lega. L'informativa li
nomina, dice a chi vanno e come si fanno togliere — e nomina il fornitore
**solo se lo si sta davvero usando**, perche' dichiarare un trasferimento che
non avviene e' sbagliato quanto tacerne uno che avviene.

Restano una bozza: vanno lette da un legale prima di incassare il primo euro.

## Il tetto alla vetrina

La lega di prova non passa dal cancello del pagamento, ed e' una scelta:
chiedere 4,99 euro a chi non ha ancora visto il prodotto e' il modo piu' sicuro
di perderlo. I dati sono sintetici, quindi non e' il prodotto regalato — e' la
vetrina. Ma genera tre edizioni con una chiave vera, e senza un tetto
quell'azione si ripete all'infinito mentre il conto lo paga chi ospita.

**Due per account**, configurabile. Una per guardare il prodotto, una per
riprovare con impostazioni diverse; la terza non mostra niente di nuovo.

Il tetto conta il campo `origine`, non il prefisso dell'identificatore. Le leghe
di prova si chiamano gia' `prova-...` e contarle da li' funzionerebbe — finche'
qualcuno non rinomina, e allora il limite sparirebbe senza che niente lo
segnali. Un limite che si disattiva da solo e' peggio di nessun limite, perche'
si continua a credere che ci sia.

Tre cose imparate scrivendolo, tutte da qualcosa che e' fallito:

- **le tre implementazioni dello store divergevano.** Postgres leggeva la
  colonna vuota come `utente`, file e memoria restituivano `undefined`. L'ha
  detto la suite di contratto, che gira identica sulle tre: adesso una sola
  funzione normalizza in lettura, e chi legge non deve ricordarsi di gestire
  due forme — cioe' non puo' dimenticarsene da qualche parte
- **una variabile d'ambiente vuota non e' zero.** `Number('')` fa zero, quindi
  la lettura ingenua spegneva la vetrina ogni volta che un file di deploy
  dichiarava la variabile senza valorizzarla
- **il controllo sta prima di spendere.** Dopo la generazione direbbe di no
  avendo gia' pagato il conto

E la regola sta in una funzione pura con i suoi test, mentre il **cablaggio**
lo verifica il browser: un tetto scollegato dall'azione non e' meta' tetto, e'
un tetto che non c'e' mentre sembra esserci. Mutato via il collegamento, la
verifica dice «il tetto non ha fermato niente» invece di scadere dopo tre
minuti con un timeout che non nomina il colpevole.

## La posta

Finche' esistevano solo il mailer su console e quello su file, il magic link si
conosceva solo leggendo i log del server: l'app si poteva provare, non si poteva
aprire a nessuno.

**SMTP e non l'API di un fornitore.** SMTP lo parlano tutti — la casella che si
ha gia', il proprio dominio, e anche i servizi transazionali, che offrono tutti
un accesso SMTP oltre alla loro API. Scegliere l'API di uno significherebbe
sceglierlo per conto di chi possiede il prodotto, e cambiarlo diventerebbe un
rilascio invece di una variabile d'ambiente. Il limite va detto invece che
scoperto: alcune piattaforme serverless chiudono le porte SMTP in uscita; se
succede la strada e' un mailer HTTP accanto a questo, e il resto del codice non
se ne accorge.

**Il mittente e' separato dall'utente SMTP**, perche' quasi mai coincidono: ci
si autentica come `apikey` e si spedisce da `noreply@dominio`. Scambiarli non
da' un errore — da' una consegna che finisce nello spam, cioe' un accesso che
«non arriva» senza che niente risulti rotto. Il TLS si deduce dalla porta (465
diretto, 587 con STARTTLS), che e' la domanda che tutti sbagliano e la cui
risposta e' sempre la stessa.

**In produzione l'app non parte senza posta**, e non parte nemmeno se le
credenziali sono rifiutate: si prova la connessione all'avvio, quando qualcuno
sta guardando. Un magic link che finisce in un file mentre l'utente legge «ti
abbiamo mandato una mail» non e' un errore che qualcuno segnala: e' un utente
che non torna.

### La garanzia si verifica, non si aggira

Quella regola ha rotto subito tutte le verifiche end-to-end, perche'
`next start` gira sempre con `NODE_ENV=production` e li' la posta non c'era. Le
strade erano due: un'eccezione per le verifiche, o dare alle verifiche una
posta vera. La prima avrebbe reso la garanzia una decorazione — il caso che
deve impedire e' esattamente quello che l'eccezione riapriva.

Quindi `posta-finta.ts`: un server che parla SMTP davvero e scrive cio' che
riceve nello stesso registro del `FileMailer`. Le verifiche che leggevano di
li' continuano a leggere di li', e adesso lo fanno **attraverso una
conversazione SMTP** invece di scavalcarla. Il percorso della posta e' passato
da «mai verificato» a «verificato a ogni giro», ed e' lo STESSO server che usa
il test del mailer: una copia proverebbe il mailer contro un interlocutore
diverso da quello con cui poi gira.

Due difetti trovati cosi', non rileggendo il codice:

- il quoted-printable si decodificava un carattere alla volta. Una lettera
  accentata in UTF-8 sono due byte — `é` e' `=C3=A9` — e presi separatamente
  diventano «Ã©». Sui magic link, che sono ASCII, non si vedeva; su ogni
  oggetto in italiano si'
- la riga d'avvio della posta finta non compariva nel log, perche' Node
  bufferizza stdout quando non e' un terminale. Il controllo che in CI verifica
  che la posta sia partita avrebbe dato un falso guasto. E' lo stesso motivo
  per cui il `FileMailer` scrive sincrono, ed e' costato un giro riscoprirlo

## Il pagamento

4,99 € **una tantum per lega e per stagione**. Non un abbonamento: chi gioca al
fantacalcio paga l'iscrizione alla lega una volta all'anno, e un addebito
mensile su un prodotto che vive da settembre a maggio e' una disdetta
annunciata.

**Il diritto sta sulla LEGA, non sull'account.** Metterlo sull'account avrebbe
significato che il primo pagamento apre tutte le leghe presenti e future dello
stesso proprietario — cioe' un prodotto gratis per chiunque abbia un amico che
paga. Ed e' **per stagione**: pagare il 2025-26 non apre il 2026-27.

### Il cancello sta prima delle spese

Dopo il controllo si interroga un servizio a consumo e si fa girare un modello a
pagamento. Un cancello messo alla fine avrebbe lasciato che una lega non pagata
costasse esattamente quanto una pagata, con l'unica differenza che il giornale
non si vede.

I percorsi verso quella spesa erano **tre**, non uno: il pianificatore, la
vigilia fatta uscire a mano, e l'import da CSV. Ne avevo chiusi due, e il terzo
avrebbe continuato a pubblicare gratis — un controllo applicato su due percorsi
su tre vale quanto il percorso che lascia aperto. Il test di sicurezza guidato
da browser e' quello che l'ha trovato.

L'eccezione dichiarata e' la **lega di prova**: dati sintetici, serve
all'onboarding, e chiedere 4,99 € prima di far vedere il prodotto e' il modo
piu' sicuro di perdere chi si e' appena iscritto. Il suo costo pero' e' reale —
tre edizioni con una chiave vera — e oggi nulla impedisce di ripeterla in
continuazione: e' un'esposizione da chiudere con un tetto per account prima di
aprire le iscrizioni.

### La firma del webhook e' tutto

E' l'unica cosa che separa «hanno pagato» da «qualcuno ha fatto una POST». Senza,
chiunque conosca l'indirizzo attiva le leghe che vuole — non una fuga di dati:
il prodotto regalato.

E' un HMAC-SHA256 su `timestamp.corpo`, scritto in casa in quindici righe invece
di importare l'SDK: la parte che tocca input non fidato e' la parte che si vuole
piccola e leggibile per intero, come il lettore xlsx. Tre dettagli che non sono
dettagli:

- **Si legge il corpo GREZZO**, mai il JSON gia' analizzato. La firma copre i
  byte esatti: riserializzare un oggetto cambia spazi e ordine dei campi, e la
  verifica fallirebbe su richieste valide.
- **Lo scarto del timestamp si controlla in valore assoluto.** Solo «troppo
  vecchia» lascerebbe passare una firma nel futuro, e un orologio sfasato in
  avanti la renderebbe valida per ore dopo la scadenza.
- **Un evento che non ci riguarda riceve 200**, non un errore. Stripe manda
  decine di tipi; rispondere male lo fa ritentare all'infinito e alla fine
  disattiva l'endpoint — cioe' i pagamenti veri smettono di arrivare. Lo stesso
  vale per la riconsegna dello stesso evento, che e' la garanzia «almeno una
  volta» di Stripe e non un guasto: l'idempotenza e' sull'id dell'evento, e su
  Postgres sta nella `WHERE`, non in un «leggi, decidi, scrivi» che lascerebbe
  aperta la finestra fra due riconsegne simultanee.

Si controlla anche l'**importo**. Non e' una difesa contro un attaccante —
senza la nostra chiave nessuno crea sessioni — e' una difesa contro noi stessi:
un prezzo cambiato in un posto e non nell'altro attiverebbe leghe per l'importo
sbagliato senza che nessuno se ne accorga.

### Verificato contro uno Stripe finto

Da qui `api.stripe.com` non e' raggiungibile, e un pagamento verificabile solo
in produzione e' un pagamento non verificato. L'indirizzo di Stripe e'
configurabile, quindi la catena intera — sessione, redirect, webhook firmato,
attivazione — gira sopra HTTP vero contro un finto che firma con lo stesso HMAC.
**La firma non viene mai disattivata**: disattivarla significherebbe verificare
qualcos'altro. Si prova che senza firma, con una firma altrui, col corpo
manomesso di un carattere e con una firma vecchia di un'ora non succede niente.

## Cosa manca

Per andare in produzione servono, nell'ordine:

1. **Le chiavi vere di Stripe** e l'endpoint del webhook registrato sulla
   dashboard. Il codice c'e' ed e' verificato contro un finto; quel che manca
   e' configurazione.
2. **Il piano globale: fatto, ma la prima richiesta vera non l'ha fatta
   nessuno.** Il profilo `fantacalcio-it` e' completo — indirizzo con stagione
   e giornata, selettori presi da una pagina pubblicata davvero, test su un suo
   ritaglio, robots.txt loro verificato — ma da questo ambiente quel dominio non
   e' raggiungibile, quindi va eseguito una volta da una macchina che lo
   raggiunge, su una giornata finita, guardando che la riconciliazione torni.
   Il piano della LEGA — chi ha schierato chi — non sta li' e resta
   all'estensione: non e' dato di quel sito, e' dato privato dell'utente.
3. **Le credenziali SMTP.** Il mailer c'e' ed e' verificato contro un server
   SMTP vero; manca la casella da cui spedire — `SMTP_HOST`, `SMTP_USER`,
   `SMTP_PASSWORD`, `SMTP_FROM`. Va bene qualunque fornitore, compresa la
   propria casella: e' configurazione, non codice. Senza, in produzione l'app
   **non parte**, apposta.
4. **Consegna**: bot Telegram per l'automazione, PWA con Web Share API per la
   condivisione su WhatsApp (l'API di WhatsApp non scrive nei gruppi: qualsiasi
   piano che lo assuma è irrealizzabile).
5. **Fonte xG** con licenza commerciale verificata.
5bis. **Termini e privacy letti da un legale**, e l'accettazione del recesso
   raccolta nel checkout: il testo c'e' ed e' dichiaratamente una bozza.
6. **Revisione umana al 100%** per le prime settimane: è così che si costruisce
   il dataset di stile, non un ripiego.
7. **pgvector** per la memoria semantica anti-ripetizione: oggi il cooldown è
   per tipo di fatto e per format, non per similarità del testo generato.
8. **Il driver Anthropic contro l'API vera**: il codice c'è e l'assemblaggio
   della richiesta è testato, ma finora ha girato solo il driver template.

## Licenza e dati

I dati di Serie A e delle leghe appartengono alle rispettive piattaforme. Il
collector consigliato lavora nella sessione dell'utente sui dati che l'utente ha
già diritto di vedere; l'import da file è la via sempre disponibile. Prima di
qualsiasi accesso automatizzato a una piattaforma terza vanno verificati i suoi
termini di servizio.
