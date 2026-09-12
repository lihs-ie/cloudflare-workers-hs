document.querySelector('#check').addEventListener('click', async () => {
  const status = document.querySelector('#status');
  status.textContent = '確認中…';
  try {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error('API failed');
    const result = await response.json();
    status.textContent = `${result.status} — ${result.runtime}`;
  } catch { status.textContent = '接続できませんでした。もう一度お試しください。'; }
});
