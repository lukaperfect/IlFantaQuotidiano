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

create table if not exists editions (
  league_id  text not null,
  matchday   integer not null,
  edition    jsonb not null,
  -- Il pack viaggia con l'edizione: senza, il giornale non e' ricostruibile.
  pack       jsonb not null,
  primary key (league_id, matchday)
);

-- Quando un umano ha approvato un'edizione sotto soglia. Aggiunta dopo,
-- quindi come ALTER: uno schema che si applica solo ai database nuovi non e'
-- uno schema.
alter table editions add column if not exists approved_at timestamptz;

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
