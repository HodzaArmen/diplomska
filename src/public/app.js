document.getElementById('btn-register').addEventListener('click', async () => {
    const resElem = document.getElementById('wallet-result');
    resElem.textContent = "Ustvarjam denarnico...";
    try {
        const response = await fetch('/api/wallet/register', { method: 'POST' });
        const data = await response.json();
        resElem.textContent = JSON.stringify(data, null, 2);
    } catch (e) { resElem.textContent = "Napaka: " + e; }
});

document.getElementById('btn-issue').addEventListener('click', async () => {
    const resElem = document.getElementById('issuer-result');
    resElem.textContent = "Generiram ponudbo (Offer URL)...";
    try {
        const response = await fetch('/api/issuer/issue', { method: 'POST' });
        const data = await response.json();
        resElem.textContent = JSON.stringify(data, null, 2);
    } catch (e) { resElem.textContent = "Napaka: " + e; }
});

document.getElementById('btn-verify').addEventListener('click', async () => {
    const resElem = document.getElementById('verifier-result');
    resElem.textContent = "Ustvarjam zahtevo za preverjanje...";
    try {
        const response = await fetch('/api/verifier/verify', { method: 'POST' });
        const data = await response.json();
        resElem.textContent = JSON.stringify(data, null, 2);
    } catch (e) { resElem.textContent = "Napaka: " + e; }
});