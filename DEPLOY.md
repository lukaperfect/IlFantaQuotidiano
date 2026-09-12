# Pubblicare FantaComics

Lo stato di questo file e' quello di una lista di controllo, non di una guida:
ogni voce o e' fatta, o dice esattamente che cosa manca e chi la puo' fare.

## Dove gira

| Pezzo | Dove | Stato |
|---|---|---|
| App web (Next.js) | Vercel, team `HeyBunny` | **da creare**: il collegamento in uso puo' leggere il team ma non creare progetti (403) |
| Database | Supabase, progetto `FantaComics` (`pbkjcplaosqikmiornhm`, eu-central-1) | creato, schema applicato, piano gratuito |
| Cron delle uscite | GitHub Actions, `.github/workflows/consegna.yml` | scritto; parte solo quando e' su `main` |
| Pagamenti | Stripe | codice pronto, chiavi da mettere |
| Posta | SMTP | codice pronto, casella da mettere |

## 1. Il progetto su Vercel

Da creare a mano dalla dashboard (Add New → Project → importa
`lukaperfect/FantaComics`), con **Root Directory = `apps/web`**. Vercel
riconosce da solo Next.js e il workspace pnpm.

Root Directory e' l'unica impostazione che conta: senza, l'installazione parte
nella cartella sbagliata e i pacchetti del monorepo non si risolvono.

## 2. Le variabili d'ambiente

Su Vercel, per **Production** e **Preview**.

### Obbligatorie: senza, l'app si rifiuta di partire

| Nome | Valore | Da dove viene |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:<password>@db.pbkjcplaosqikmiornhm.supabase.co:5432/postgres` | Supabase → Settings → Database → Connection string. La password si imposta o si rigenera li'. |
| `FANTACOMICS_SECRET` | una stringa casuale di almeno 32 caratteri | firma le sessioni |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` | la casella da cui partono i link d'accesso | qualunque fornitore, anche la propria casella |

Senza posta l'app **non parte**, ed e' deliberato: un magic link che finisce in
un log mentre l'utente legge «ti abbiamo mandato una mail» non e' un errore che
qualcuno segnala, e' un utente che non torna.

### Necessarie perche' il prodotto faccia il suo mestiere

| Nome | Valore |
|---|---|
| `FANTACOMICS_URL` | l'indirizzo pubblico, senza barra finale. Ci finiscono dentro i magic link e le immagini di anteprima |
| `FANTACOMICS_CRON_SECRET` | una stringa casuale: autentica il cron |
| `STRIPE_SECRET_KEY` | chiave segreta di Stripe |
| `STRIPE_WEBHOOK_SECRET` | segreto del webhook, dopo averlo registrato (punto 4) |
| `ANTHROPIC_API_KEY` | senza, i giornali escono col motore a modelli fissi: veri ma secchi |

### Per le pagine legali

`FANTACOMICS_TITOLARE`, `FANTACOMICS_PIVA`, `FANTACOMICS_INDIRIZZO`,
`FANTACOMICS_EMAIL_CONTATTO`. Finche' mancano, `/termini` e `/privacy` mostrano
in testa un avviso che dichiara di essere bozze incomplete — e restano da far
leggere a un legale prima di incassare il primo euro.

### Facoltative

`FANTACOMICS_MAX_LEGHE_PROVA` (predefinito 2), `FANTACOMICS_PROFILI_FONTE`
(per collegare una fonte diversa senza un rilascio).

## 3. Il cron

Su GitHub, Settings → Secrets and variables → Actions:

- `FANTACOMICS_URL`: lo stesso indirizzo pubblico
- `FANTACOMICS_CRON_SECRET`: lo stesso segreto messo su Vercel

Il workflow gira **solo dal branch predefinito**: finche' il lavoro sta su un
branch, il cron non parte. Si puo' lanciare a mano da Actions → Consegna → Run
workflow, anche prima.

## 4. Stripe

1. Chiavi da dashboard → `STRIPE_SECRET_KEY`.
2. Webhook verso `https://<indirizzo>/api/stripe`, evento
   `checkout.session.completed`. Il segreto che Stripe mostra va in
   `STRIPE_WEBHOOK_SECRET`.
3. **Prima di incassare**: il checkout deve raccogliere l'accettazione
   esplicita dell'esecuzione immediata, altrimenti il diritto di recesso di
   quattordici giorni resta in piedi su un prodotto gia' consegnato. I termini
   lo dicono; il checkout non lo chiede ancora.

## 5. Da verificare prima di aprire le iscrizioni

- **Il piano di Vercel.** Il team e' su Hobby. Le condizioni d'uso di Vercel
  vanno lette: il piano gratuito e' documentato come per uso personale e non
  commerciale, e questo prodotto incassa. Non e' una difficolta' tecnica, e'
  una voce di costo da mettere in conto (Pro) o un hosting da cambiare.
- **La sicurezza del database.** Vedi qui sotto.

## La sicurezza del database Supabase

Le dieci tabelle sono create **senza Row Level Security**. Supabase espone una
API pubblica (PostgREST) sul progetto, e con RLS disattivata chiunque abbia la
chiave `anon` — che per come e' pensata sta nel codice dei client, cioe' e'
pubblica — puo' leggere e modificare ogni riga: account, hash dei magic link,
leghe, edizioni.

Questa app non usa quella API: parla con Postgres direttamente. Quindi qui la
soluzione e' netta e non rompe niente — si attiva RLS **senza nessuna policy**,
il che chiude fuori `anon` e `authenticated` mentre la connessione diretta
dell'app, che e' proprietaria delle tabelle, continua a funzionare:

```sql
alter table public.accounts             enable row level security;
alter table public.magic_links          enable row level security;
alter table public.issue_throttle       enable row level security;
alter table public.leagues              enable row level security;
alter table public.editions             enable row level security;
alter table public.league_entitlements  enable row level security;
alter table public.league_state         enable row level security;
alter table public.corpus_points        enable row level security;
alter table public.league_rosters       enable row level security;
alter table public.serie_a_osservazioni enable row level security;
```

Da eseguire in Supabase → SQL Editor. In alternativa, o in aggiunta, si puo'
spegnere del tutto la Data API dalle impostazioni del progetto: questa app non
la usa.

## Cosa resta da fare dopo il primo deploy

1. **La prima richiesta vera a fantacalcio.it.** Il profilo c'e', i selettori
   vengono da una pagina vera e i test girano su un suo ritaglio, ma da questo
   ambiente quel dominio non e' raggiungibile: nessuno ha ancora fatto la prima
   richiesta. Si fa collegando una lega a `fantacalcio-it` su una giornata gia'
   finita e guardando che la riconciliazione torni.
2. **Il piano della lega** — chi ha schierato chi — non sta su quel sito: e'
   dato privato dell'utente. Resta l'estensione, oppure il caricamento del
   foglio delle rose.
