"use strict";
(async function () {
  const targets = document.querySelectorAll('[data-php-price]');
  if (!targets.length) return;
  try {
    const response = await fetch('https://api.frankfurter.dev/v2/rates?base=USD&quotes=PHP', {signal: AbortSignal.timeout(8000)});
    if (!response.ok) throw new Error('Rate unavailable');
    const rates = await response.json();
    const rate = rates.find(row => row.base === 'USD' && row.quote === 'PHP');
    if (!rate || !Number.isFinite(rate.rate) || rate.rate <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(rate.date)) throw new Error('Invalid rate');
    targets.forEach(el => { el.textContent = new Intl.NumberFormat('en-PH', {style:'currency',currency:'PHP'}).format(Number(el.dataset.phpPrice)*rate.rate) + ' estimated · rate ' + rate.date; });
  } catch {
    targets.forEach(el => { el.textContent = 'PHP estimate temporarily unavailable'; });
  }
})();
