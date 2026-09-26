'use strict';
const form = document.getElementById('login-form');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  const message = document.getElementById('login-error');
  message.hidden = true;
  button.disabled = true;
  try {
    const response = await fetch('/api/dashboard/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: form.elements.password.value }),
    });
    const data = await response.json();
    form.elements.password.value = '';
    if (!response.ok) throw new Error(data.error || 'Sign-in failed');
    window.location.assign('/');
  } catch (error) {
    message.textContent = error.message || 'Cannot sign in. Try again.';
    message.hidden = false;
  } finally {
    button.disabled = false;
  }
});
