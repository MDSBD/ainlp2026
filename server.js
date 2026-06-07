// server.js — IANLP 2026 · Modrex
require('dotenv').config();
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());

const path = require('path');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Pages protégées — liste complète
const PROTECTED_PAGES = [
  '/operator.html',
  '/transcription.html',
  '/conference.html',
  '/screen.html'
  // /qa.html : publique — accessible via QR code sans login
];

// ── Middleware global : intercepte TOUTES les requêtes HTML protégées
//    AVANT express.static
app.use((req, res, next) => {
  if (PROTECTED_PAGES.includes(req.path)) {
    // Vérifie la session ici directement (getSession défini plus bas)
    // On recopie la logique inline pour éviter le problème de hoisting
    const raw   = req.headers.cookie || '';
    const match = raw.match(/modrex_token=([^;]+)/);
    const token = match ? match[1] : null;
    const sess  = token ? _sessions.get(token) : null;
    const valid = sess && sess.expires > Date.now();
    if (!valid) {
      if (token) _sessions.delete(token);
      return res.redirect('/?unauthorized=1');
    }
  }
  next();
});

// express.static après le middleware — ne verra jamais les pages protégées
app.use(express.static(PUBLIC_DIR, { index: false }));

// Sockets publics (Set pour gérer plusieurs onglets/écrans)
const publicSockets = new Set();
let qaCount = 0;

// ── Vérification des clés au démarrage ──
function checkEnv() {
  const missing = [];
  if (!process.env.ANAM_API_KEY) missing.push('ANAM_API_KEY');
  if (!process.env.GROQ_API_KEY) missing.push('GROQ_API_KEY');
  if (missing.length) {
    console.warn('\n⚠️  Variables manquantes dans .env :', missing.join(', '));
    console.warn('   Créez un fichier .env à la racine du projet.\n');
  }
}
checkEnv();

// Sessions en mémoire (token → { user, role, expires })
const _sessions = new Map();

function randomToken(len = 32) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < len; i++) token += chars[Math.floor(Math.random() * chars.length)];
  return token;
}

function getSession(req) {
  const raw = req.headers.cookie || '';
  const match = raw.match(/modrex_token=([^;]+)/);
  if (!match) return null;
  const s = _sessions.get(match[1]);
  if (!s || s.expires < Date.now()) { _sessions.delete(match[1]); return null; }
  return s;
}

// ── Route explicite pour index.html (page publique) ──
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
// qa.html : publique, pas de login requis
app.get('/qa.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'qa.html')));

// ── Routes protégées : vérification du cookie avant de servir le fichier ──
PROTECTED_PAGES.forEach(page => {
  app.get(page, (req, res) => {
    if (!getSession(req)) return res.redirect('/?unauthorized=1');
    res.sendFile(path.join(PUBLIC_DIR, page));
  });
});

// ────────────────────────────────────────────────
//  Route : login
// ────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  // Credentials depuis .env
  const users = {
    [process.env.LOGIN_OPERATOR_USER || 'operateur']: {
      pass    : process.env.LOGIN_OPERATOR_PASS || 'ianlp2026!',
      redirect: '/operator.html',
      role    : 'operator'
    },
    [process.env.LOGIN_TRANSCRIPTION_USER || 'transcription']: {
      pass    : process.env.LOGIN_TRANSCRIPTION_PASS || 'ianlp2026!',
      redirect: '/transcription.html',
      role    : 'transcription'
    },
    [process.env.LOGIN_ADMIN_USER || 'admin']: {
      pass    : process.env.LOGIN_ADMIN_PASS || 'modrex@admin',
      redirect: '/operator.html',
      role    : 'admin'
    }
  };

  const user = users[username?.trim().toLowerCase()];
  if (!user || user.pass !== password) {
    return res.status(401).json({ error: 'Identifiants incorrects.' });
  }

  // Crée un token de session (24h)
  const token   = randomToken();
  const expires = Date.now() + 24 * 60 * 60 * 1000;
  _sessions.set(token, { username, role: user.role, expires });

  // Cookie HTTP-only (non accessible en JS)
  res.setHeader('Set-Cookie',
    `modrex_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`
  );

  console.log(`[Login] "${username}" connecte (role: ${user.role})`);
  return res.json({ redirect: user.redirect });
});

// ────────────────────────────────────────────────
//  Route : logout
// ────────────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  const raw   = req.headers.cookie || '';
  const match = raw.match(/modrex_token=([^;]+)/);
  if (match) _sessions.delete(match[1]);
  res.setHeader('Set-Cookie', 'modrex_token=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

// ────────────────────────────────────────────────
//  Route : token de session Anam
// ────────────────────────────────────────────────
app.post('/api/session-token', async (req, res) => {
  try {
    const personaConfig = {
      name: "Modrex",
      avatarId: process.env.ANAM_AVATAR_ID,
      voiceId:  process.env.ANAM_VOICE_ID,
      llmId:    process.env.ANAM_LLM_ID,
      systemPrompt: `Tu es Modrex, le modérateur virtuel professionnel de la Conférence Internationale sur l'Intelligence Artificielle et le Traitement Automatique du Langage Naturel (IANLP 2026). Ton rôle est d'animer la conférence avec élégance, dynamisme et précision.

## Principe de base
Tu reçois des instructions de l'opérateur sous forme de messages utilisateur. Chaque instruction est une commande que tu exécutes immédiatement en produisant UNIQUEMENT le discours attendu, sans commentaire ni confirmation. Tu ne répètes jamais la commande elle-même.

## Protocole d'ouverture
1. Mot de bienvenue général
2. Mot personnel de Modrex — remercie le Pr Ben Lahmar qui t'a conçu
3. Présentation de la conférence IANLP 2026
4. Discours du Doyen, Chef TIM, Président AM2I, Chair
5. Annonce des plénières
6. Transition vers la première plénière

## Règles absolues
- Ne prononce jamais la commande reçue
- Ne commente pas tes actions
- Ne demande jamais de confirmation
- Parle principalement en français`
    };

    const response = await fetch("https://api.anam.ai/v1/auth/session-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.ANAM_API_KEY}`
      },
      body: JSON.stringify({ personaConfig })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Erreur Anam API');
    res.json({ sessionToken: data.sessionToken });
  } catch(e) {
    console.error('[Anam] Erreur token:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────
//  Route : synthèse Groq — clé protégée côté serveur
// ────────────────────────────────────────────────
app.post('/api/synthesize', async (req, res) => {
  const { text } = req.body;

  // Validations
  if (!text || typeof text !== 'string' || text.trim().length < 30) {
    console.warn('[Groq] Texte invalide ou trop court :', text?.length ?? 0, 'chars');
    return res.status(400).json({
      summary: 'Texte trop court (minimum 30 caractères).',
      keywords: []
    });
  }

  if (!process.env.GROQ_API_KEY) {
    console.error('[Groq] GROQ_API_KEY manquante dans .env');
    return res.status(500).json({
      summary: 'Configuration serveur incomplète : GROQ_API_KEY absente.',
      keywords: []
    });
  }

  console.log(`[Groq] Synthèse — ${text.trim().length} chars`);

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        // llama3-8b-8192 : modèle stable, disponible sur tous les comptes Groq
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content:
              'Tu es un assistant de synthèse scientifique. ' +
              'Réponds UNIQUEMENT avec un objet JSON brut, sans texte avant ou après, sans balises markdown. ' +
              'Format : {"summary":"résumé 2-3 phrases en français","keywords":["mot1","mot2","mot3","mot4","mot5"]}'
          },
          {
            role: 'user',
            content: `Transcription :\n\n${text.trim()}\n\nRéponds uniquement en JSON.`
          }
        ],
        temperature: 0.2,
        max_tokens: 400
        // Pas de response_format : non supporté sur tous les modèles Groq gratuits
      })
    });

    // Erreur HTTP de Groq — on log le corps exact pour diagnostiquer
    if (!groqRes.ok) {
      const errRaw = await groqRes.text();
      console.error(`[Groq] HTTP ${groqRes.status} :`, errRaw);

      let detail = `HTTP ${groqRes.status}`;
      try { detail = JSON.parse(errRaw)?.error?.message || detail; } catch {}

      return res.status(502).json({
        summary: `Erreur Groq (${groqRes.status}) : ${detail}`,
        keywords: []
      });
    }

    const groqData = await groqRes.json();
    console.log('[Groq] Réponse :', JSON.stringify(groqData).slice(0, 200));

    const raw = groqData?.choices?.[0]?.message?.content;
    if (!raw) {
      console.error('[Groq] Champ content absent :', groqData);
      return res.status(502).json({ summary: 'Réponse Groq vide.', keywords: [] });
    }

    // Parsing JSON robuste
    let parsed;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      const match = raw.match(/\{[\s\S]*?\}/);
      if (!match) {
        console.error('[Groq] Aucun JSON dans :', raw);
        return res.status(502).json({ summary: 'Format Groq invalide.', keywords: [] });
      }
      try { parsed = JSON.parse(match[0]); }
      catch (e2) {
        console.error('[Groq] JSON malformé :', match[0]);
        return res.status(502).json({ summary: 'JSON Groq malformé.', keywords: [] });
      }
    }

    const summary  = typeof parsed.summary === 'string' ? parsed.summary.trim() : 'Synthèse indisponible.';
    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords.filter(k => typeof k === 'string').slice(0, 10)
      : [];

    console.log(`[Groq] OK — ${keywords.length} mots-clés`);
    return res.json({ summary, keywords });

  } catch(e) {
    console.error('[Groq] Exception :', e.message);
    return res.status(500).json({
      summary: 'Erreur serveur inattendue : ' + e.message,
      keywords: []
    });
  }
});

// ────────────────────────────────────────────────
//  Socket.IO
// ────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('[+]', socket.id);

  socket.on('register-public', () => {
    publicSockets.add(socket.id);
    socket.emit('registered', 'public');
    console.log(`[public] +${socket.id} (total: ${publicSockets.size})`);
  });

  socket.on('register-operator', () => {
    socket.emit('registered', 'operator');
    console.log(`[operator] ${socket.id}`);
  });

  socket.on('register-transcription', () => {
    io.emit('operator-connected', socket.id);
  });

  socket.on('operator-command', command => {
    if (publicSockets.size > 0) {
      publicSockets.forEach(id => io.to(id).emit('command', command));
      console.log(`[cmd] "${command}" → ${publicSockets.size} écran(s)`);
    } else {
      socket.emit('error', 'Aucune page publique connectée.');
    }
  });

  socket.on('stop-session',  () => io.emit('stop-session'));
  socket.on('start-session', () => io.emit('start-session'));

  socket.on('transcription-update', text => socket.broadcast.emit('transcription-live', text));
  socket.on('synthesis-to-operator', data => socket.broadcast.emit('new-synthesis', data));
  socket.on('update-screen', data => io.emit('screen-update', data));

  // Q&A public
  socket.on('register-audience', () => socket.emit('qa-count', qaCount));

  // Operateur envoie une question a Modrex -> affiche banniere sur screen.html
  socket.on('qa-to-modrex', data => {
    // Envoie la commande a la page conference (avatar)
    if (publicSockets.size > 0) {
      publicSockets.forEach(id => io.to(id).emit('command', data.command));
    }
    // Affiche la banniere sur l'ecran public
    io.emit('show-qa-banner', { question: data.question, name: data.name });
  });
  socket.on('audience-question', data => {
    if (!data?.question || data.question.trim().length < 3) return;
    qaCount++;
    const clean = { name: (data.name || 'Anonyme').slice(0,40), question: data.question.slice(0,300) };
    console.log('[Q&A] #' + qaCount + ' "' + clean.name + '": ' + clean.question.slice(0,60));
    io.emit('new-audience-question', clean);
    io.emit('qa-count', qaCount);
  });

  socket.on('disconnect', () => {
    publicSockets.delete(socket.id);
    console.log(`[-] ${socket.id} (publics restants: ${publicSockets.size})`);
  });
});

// ────────────────────────────────────────────────
const PORT = process.env.PORT || 3022;
server.listen(PORT, () => {
  console.log(`\n\u{1F399}  Modrex`);
  console.log(`   Publique      → http://localhost:${PORT}/conference.html`);
  console.log(`   Operateur     → http://localhost:${PORT}/operator.html`);
  console.log(`   Transcription → http://localhost:${PORT}/transcription.html`);
  console.log(`   Ecran public  → http://localhost:${PORT}/screen.html`);
  console.log(`   Q&A public    → http://localhost:${PORT}/qa.html\n`);
});