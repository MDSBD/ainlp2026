// server.js — IANLP 2026 · Modrex
require('dotenv').config();
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());
app.use(express.static('public'));

// Sockets publics (Set pour gérer plusieurs onglets/écrans)
const publicSockets = new Set();

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

// ────────────────────────────────────────────────
//  Route : token de session Anam
// ────────────────────────────────────────────────
app.post('/api/session-token', async (req, res) => {
  try {
    const personaConfig = {
      name: "Modrex",
      avatarId: "4ccba9ca-bc65-4b01-9f2e-19d0d548a3b7",
      voiceId:  "8e67ed57-4fc0-11f1-84b0-52bacf74fa75",
      llmId:    "a7cf662c-2ace-4de1-a21e-ef0fbf144bb7",
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
        // llama-3.1-8b-instant : modèle stable, disponible sur tous les comptes Groq
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

  socket.on('disconnect', () => {
    publicSockets.delete(socket.id);
    console.log(`[-] ${socket.id} (publics restants: ${publicSockets.size})`);
  });
});

// ────────────────────────────────────────────────
const PORT = process.env.PORT || 3022;
server.listen(PORT, () => {
  console.log(`\n🎙️  Modrex`);
  console.log(`   Publique      → http://localhost:${PORT}/conference.html`);
  console.log(`   Opérateur     → http://localhost:${PORT}/operator.html`);
  console.log(`   Transcription → http://localhost:${PORT}/transcription.html`);
  console.log(`   Écran public  → http://localhost:${PORT}/screen.html\n`);
});