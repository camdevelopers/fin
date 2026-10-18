const REPO = 'camdevelopers/work1'; // ← change this
const API = `https://api.github.com/repos/${REPO}`;

function authHeaders() {
  const token = localStorage.getItem('fe_token');
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'office-pwa'
  };
}

// --- Pull: get latest commit SHA ---
export async function getLatestSHA() {
  const res = await fetch(`${API}/commits/HEAD`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`GET HEAD failed: ${res.status}`);
  const data = await res.json();
  return data.sha;
}

// --- Pull: list files in changes/ ---
export async function listChanges() {
  const res = await fetch(`${API}/contents/changes?ref=HEAD`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`List changes failed: ${res.status}`);
  const files = await res.json();
  return files.filter(f => f.name.endsWith('.csv')).map(f => f.name);
}

// --- Pull: download a single file's content ---
export async function fetchFileContent(path) {
  const res = await fetch(`${API}/contents/${path}?ref=HEAD`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Fetch ${path} failed: ${res.status}`);
  const data = await res.json();
  return atob(data.content); // base64 → string
}

// --- Push: create a new file ---
export async function pushFile(path, content, message) {
  const token = localStorage.getItem('fe_token');
  const encoded = btoa(unescape(encodeURIComponent(content)));

  const res = await fetch(`${API}/contents/${path}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'office-pwa'
    },
    body: JSON.stringify({ message, content: encoded })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Push ${path} failed: ${res.status} ${err.message || ''}`);
  }
  return res.json();
}   
