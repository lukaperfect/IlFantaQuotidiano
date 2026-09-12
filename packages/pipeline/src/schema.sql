-- Schema di FantaComics.
--
-- Nota sulle chiavi esterne: `editions` e `league_state` NON referenziano
-- `leagues`. La pipeline puo' produrre un'edizione senza che esista una riga
-- di lega (e' il caso della CLI di simulazione), e le due implementazioni
-- dello store condividono la stessa suite di contratto: un vincolo presente
-- solo su Postgres le renderebbe non intercambiabili, che e' esattamente cio'
-- che l'astrazione serve a garantire.

create table if not exists accounts (
  account_id  text primary key,
  email       text not null unique,
  created_at  timestamptz not null
);

create table if not exists magic_links (
  token_hash  text primary key,
  account_id  text not null references accounts(account_id) on delete cascade,
  expires_at  bigint not null,
  used_at     bigint
);
-- Hash del nonce del browser richiedente. Aggiunto dopo, quindi come ALTER:
-- `create table if not exists` non tocca una tabella che esiste gia', e uno
-- schema che si applica solo ai database nuovi non e' uno schema.
alter table magic_links add column if not exists nonce_hash text;
-- La potatura dei link scaduti scandisce su expires_at.
create index if not exists magic_links_expires_at_idx on magic_links (expires_at);

create table if not exists issue_throttle (
  email      text primary key,
  issued_at  bigint not null
);

create table if not exists leagues (
  league_id     text primary key,
  owner_id      text not null,
  -- L'indirizzo pubblico e' unico e revocabile: rigenerarlo libera il vecchio.
  public_slug   text not null unique,
  league_name   text not null,
  ruleset       jsonb not null,
  spice         smallint not null,
  created_at    timestamptz not null,
  last_matchday integer
);
-- La chiave dell'estensione: aggiunta dopo, quindi come ALTER, e nullabile
-- perche' esiste solo dalle leghe che l'hanno chiesta in poi. L'unicita' e'
-- del database: ruotarla libera la vecchia senza dipendere dal codice.
alter table leagues add column if not exists relay_secret text;
create unique index if not exists leagues_relay_secret_idx on leagues (relay_secret);
create index if not exists leagues_owner_idx on leagues (owner_id);

-- Da dove viene la lega: la vetrina o un utente. Aggiunta dopo, quindi ALTER.
-- Non e' deducibile dal prefisso dell'identificatore: quello e' una convenzione,
-- e un tetto che si regge su una convenzione si disattiva al primo rinominare.
alter table leagues add column if not exists origine text;

create table if not exists editions (
  league_id  text not null,
  matchday   integer not null,
  -- 'giornale' (la mattina dopo l'ultima partita) o 'anteprima' (la mattina in
  -- cui si comincia a giocare). Le due uscite della settimana parlano della
  -- STESSA giornata, quindi il tipo fa parte della chiave: senza, la seconda
  -- sovrascriverebbe la prima e il cliente perderebbe un numero su due.
  kind       text not null default 'giornale',
  edition    jsonb not null,
  -- Il pack viaggia con l'edizione: senza, il giornale non e' ricostruibile.
  pack       jsonb not null,
  primary key (league_id, matchday, kind)
);

-- Per i database creati prima che l'anteprima esistesse. Le due istruzioni
-- sono idempotenti, e su un database nuovo ridichiarano la stessa chiave che
-- il create ha appena messo: costa una riscrittura dell'indice all'avvio e non
-- lascia due percorsi di schema che possono divergere.
alter table editions add column if not exists kind text not null default 'giornale';
alter table editions drop constraint if exists editions_pkey;
alter table editions add primary key (league_id, matchday, kind);

-- Quando un umano ha approvato un'edizione sotto soglia. Aggiunta dopo,
-- quindi come ALTER: uno schema che si applica solo ai database nuovi non e'
-- uno schema.
alter table editions add column if not exists approved_at timestamptz;

-- IL DIRITTO A PUBBLICARE, per lega e per stagione.
--
-- Sta sulla lega e non sull'account: si paga l'iscrizione a UNA lega, e chi ne
-- amministra due ne paga due. Una tabella e non una colonna su `leagues`
-- perche' le stagioni si accumulano: il pagamento del 2025-26 resta a
-- archivio anche dopo che si e' pagato il 2026-27.
create table if not exists league_entitlements (
  league_id     text not null,
  season        text not null,
  paid_at       timestamptz not null,
  -- L'evento di Stripe: e' la chiave dell'idempotenza. Stripe consegna lo
  -- stesso evento piu' volte, ed e' la sua garanzia, non un guasto.
  event_id      text not null,
  session_id    text not null,
  amount_cents  integer not null,
  currency      text not null,
  primary key (league_id, season)
);

create table if not exists league_state (
  league_id  text primary key,
  memory     jsonb not null,
  history    jsonb not null
);

create table if not exists corpus_points (
  id      bigserial primary key,
  points  double precision not null
);
create index if not exists corpus_points_value_idx on corpus_points (points);

-- Le rose durano una stagione, non una giornata: tabella separata dalle
-- edizioni. Come `editions` e `league_state`, non referenzia `leagues` — per
-- la stessa ragione, cioe' per non rendere le due implementazioni dello store
-- diverse fra loro.
create table if not exists league_rosters (
  league_id  text primary key,
  roster     jsonb not null
);

-- Le osservazioni della giornata globale di Serie A: servono alla macchina a
-- stati, che dichiara i voti stabili solo dopo letture consecutive identiche.
-- Non sono per lega, come il piano globale a cui appartengono.
create table if not exists serie_a_osservazioni (
  id           bigserial primary key,
  season       text not null,
  matchday     integer not null,
  osservazione jsonb not null
);
create index if not exists serie_a_osservazioni_giornata_idx
  on serie_a_osservazioni (season, matchday, id);

-- Da dove arrivano i dati della giornata, quando arrivano da soli. Aggiunta
-- dopo, quindi come ALTER: uno schema che si applica solo ai database nuovi
-- non e' uno schema.
alter table leagues add column if not exists fonte jsonb;
