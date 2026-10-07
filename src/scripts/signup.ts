// Submits any form marked data-signup to the signup API. data-done and data-link are the thank-you text and
// link label; the reply's one-time Telegram link ties the visitor's chat to what they just sent.
for (const form of document.querySelectorAll<HTMLFormElement>('form[data-signup]')) {
  const status = form.querySelector('.status') as HTMLElement;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const endpoint = form.dataset.endpoint;
    if (!endpoint) {
      status.textContent = 'Signups are not live yet. Text Misha directly for now.';
      return;
    }
    const data = Object.fromEntries(new FormData(form));
    status.textContent = 'TRANSMITTING…';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(String(res.status));
      const { telegram } = await res.json().catch(() => ({}));
      form.reset();
      status.textContent = `${form.dataset.done} `;
      const link = document.createElement('a');
      link.href = telegram || 'https://t.me/starbase77bot';
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = form.dataset.link ?? 'Get launch updates on Telegram →';
      status.append(link);
    } catch {
      status.textContent = 'Something went wrong on our side. Try again in a minute.';
    }
  });
}
