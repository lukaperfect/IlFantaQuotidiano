'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { richiediAccesso, type EsitoAccesso } from '@/app/actions';

function Invia() {
  const { pending } = useFormStatus();
  return (
    <button className="btn btn--primary" type="submit" disabled={pending}>
      {pending ? 'Invio…' : 'Mandami il link'}
    </button>
  );
}

export function LoginForm() {
  const [esito, azione] = useActionState<EsitoAccesso | null, FormData>(richiediAccesso, null);

  return (
    <form action={azione}>
      {esito ? (
        <p className={esito.ok ? 'notice' : 'notice error'} role="status">
          {esito.messaggio}
          {esito.ok && esito.linkSviluppo ? (
            <>
              <br />
              <a href={esito.linkSviluppo}>{esito.linkSviluppo}</a>
            </>
          ) : null}
        </p>
      ) : null}

      <label>
        Email
        <input name="email" type="email" required autoComplete="email" autoFocus />
      </label>
      <div><Invia /></div>
    </form>
  );
}
