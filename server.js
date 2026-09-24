/**
 * Miami Smile Dental — MOCK backend server (Step 6)
 * ---------------------------------------------------
 * This is a FAKE / MOCK AI backend. It does NOT call any real AI provider,
 * does NOT use an API key, and does NOT cost anything to run.
 *
 * It exists to prove out the frontend <-> backend API contract from Step 5,
 * so the existing chat UI can be switched from "local JavaScript logic"
 * to "talks to a server" — before we ever connect a real AI model.
 *
 * It uses ONLY Node.js's built-in modules, so there is nothing to install.
 * You just run: node server.js
 *
 * FICTIONAL DEMO DATA ONLY — Miami Smile Dental is not a real clinic.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const PUBLIC_DIR = path.join(__dirname, 'public');

// V4 demo dashboard store. This is intentionally in-memory only: restarting
// the server clears demo appointments, so no real patient data should be used.
const APPOINTMENTS = [];

function saveDemoAppointment(body) {
  const c = (body.leadState && body.leadState.collected) || {};
  if (!c.name || !c.contact || !c.service || !c.date || !c.time) return null;
  const sessionId = String(body.sessionId || 'demo');
  const fingerprint = [sessionId, c.name, c.contact, c.service, c.date, c.time].join('|');
  if (APPOINTMENTS.some((a) => a.fingerprint === fingerprint)) return null;
  const appointment = {
    id: `MSD-${String(Date.now()).slice(-6)}`,
    name: String(c.name), contact: String(c.contact), service: String(c.service),
    date: String(c.date), time: String(c.time), status: 'New',
    createdAt: new Date().toISOString(), fingerprint,
  };
  APPOINTMENTS.unshift(appointment);
  return appointment;
}

// ---------------------------------------------------------------------------
// 1. CLINIC KNOWLEDGE BASE (stands in for the Step 5 system prompt content)
//
// When we connect a real AI later, this section is what gets converted into
// the AI's system prompt instead of hard-coded JavaScript. For now, a mock
// server uses it directly to build canned-but-structured replies.
// ---------------------------------------------------------------------------

const CLINIC = {
  name: 'Miami Smile Dental',
  phone: '(305) 555-0142',
  hours: 'Mon–Thu 8:00 AM–6:00 PM, Fri 8:00 AM–4:00 PM, Sat 9:00 AM–1:00 PM, closed Sunday',
};

const PRICES = {
  exam: '$99',
  cleaning: '$89',
  whitening: '$299',
  filling: '$150–$300',
  rootcanal: '$700–$1,200',
  crown: '$900–$1,400',
  invisalign: '$3,500–$5,500',
  extraction: '$150–$300',
  pediatric: '$79',
};

// ---------------------------------------------------------------------------
// 2. DETERMINISTIC LEAD-CAPTURE FIELD ORDER
//
// This is the fixed, structured sequence the receptionist collects.
// It is deliberately NOT decided by AI — it's plain, predictable code.
// ---------------------------------------------------------------------------

const FIELD_ORDER = ['name', 'contact', 'service', 'date', 'time'];

const FIELD_QUESTIONS = {
  name: () => "Could I grab your name to get started?",
  contact: (leadState) =>
    `Thanks, ${firstName(leadState.collected.name)}! What's the best phone number or email to reach you at?`,
  service: () => "Got it. What service are you interested in?",
  date: () => "What date would you prefer? Please use YYYY-MM-DD (for example, 2026-09-24).",
  time: (leadState) => {
    const slots = availableSlotsForDate(leadState.collected.date);
    return slots.length
      ? `Great — the demo schedule shows these available times: ${slots.join(', ')}. Which one works best?`
      : "That date has no demo availability. Please choose another clinic day.";
  },
};


// Fictional demo availability. In a real deployment these slots would come
// from the clinic's scheduling system (e.g. Open Dental / Dentrix / NexHealth).
function availableSlotsForDate(dateString) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateString || ''))) return [];
  const d = new Date(dateString + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return [];
  const day = d.getDay();
  if (day === 0) return []; // Sunday closed
  if (day === 6) return ['9:00 AM', '10:30 AM', '12:00 PM'];
  if (day === 5) return ['8:30 AM', '10:00 AM', '1:30 PM', '3:00 PM'];
  return ['8:30 AM', '10:00 AM', '1:30 PM', '3:30 PM', '5:00 PM'];
}

function firstName(fullName) {
  if (!fullName) return 'there';
  return String(fullName).trim().split(' ')[0];
}

function firstMissingField(collected) {
  return FIELD_ORDER.find((field) => !collected[field]) || null;
}

// ---------------------------------------------------------------------------
// 3. INTENT DETECTION (mock version — simple keyword rules)
//
// A real AI model will eventually replace this function's *internals*.
// The rest of the app does not need to change when that happens, because
// everything downstream only depends on the shape of the response object.
// ---------------------------------------------------------------------------

function detectIntent(text) {
  const t = (text || '').toLowerCase();

  if (/\b(can.?t breathe|cant breathe|won.?t stop bleeding|wont stop bleeding|knocked out|severe swelling|chest pain|passed out|unconscious|pain|hurts?|hurting|swoll|swelling|emergency|bleeding|broke|throbbing)\b/.test(t)) {
    return 'emergency';
  }
  if (/\b(whiten|whitening)\b/.test(t)) return 'whitening';
  if (/\b(invisalign|aligner|braces)\b/.test(t)) return 'invisalign';
  if (/\b(insurance|ppo|cover|coverage|plan)\b/.test(t)) return 'insurance';
  if (/\b(price|pricing|cost|how much|rates)\b/.test(t)) return 'pricing';
  if (/\b(hours|open|closed|close)\b/.test(t)) return 'hours';
  if (/\b(new patient|first time|first visit)\b/.test(t)) return 'newpatient';
  if (/\b(book|appointment|schedule|reserve)\b/.test(t)) return 'book';
  if (/^(yes|yeah|yep|sure|ok|okay|sounds good|please|yes please)\b/.test(t.trim())) return 'affirm';
  if (/^(no|nah|not now|no thanks|maybe later)\b/.test(t.trim())) return 'deny';
  return 'unknown';
}

// Looks at the last assistant message to guess whether it just offered to
// book/schedule something — used so a plain "yes" after an offer makes sense.
function lastTurnOfferedBooking(conversationHistory) {
  if (!Array.isArray(conversationHistory)) return false;
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const turn = conversationHistory[i];
    if (turn && turn.role === 'assistant') {
      return /would you like me to help|get that scheduled|leave your info|help get you in today/i.test(
        turn.content || ''
      );
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 4. RESPONSE BUILDERS
//
// Each of these returns an object matching the Step 5 API contract:
//   { reply, intent, requiresHumanFollowUp, isPossibleEmergency, leadCapture }
// ---------------------------------------------------------------------------

function emergencyReply() {
  return {
    reply:
      "If you're experiencing severe swelling, difficulty breathing or swallowing, uncontrolled bleeding, or a high fever, please call 911 or go to the nearest ER right away — that can be serious. " +
      `If it's a manageable but urgent issue, we may be able to arrange a same-day emergency visit. Our front desk can confirm availability and pricing — would you like me to help get you in today?`,
    intent: 'emergency',
    requiresHumanFollowUp: true,
    isPossibleEmergency: true,
    leadCapture: { shouldStart: false, shouldContinue: false, suggestedService: 'Same-Day Emergency Visit' },
  };
}

function whiteningReply() {
  return {
    reply: `Yes! We offer in-office professional teeth whitening — around ${PRICES.whitening}. Exact pricing can vary a little depending on what the dentist recommends. Would you like me to help you get that scheduled?`,
    intent: 'pricing_whitening',
    requiresHumanFollowUp: false,
    isPossibleEmergency: false,
    leadCapture: { shouldStart: false, shouldContinue: false, suggestedService: 'Teeth Whitening' },
  };
}

function invisalignReply() {
  return {
    reply: `Invisalign treatment typically runs ${PRICES.invisalign} total, depending on your case. Dr. Chen handles orthodontics and can give you an exact quote after a consultation. Would you like me to help you get that scheduled?`,
    intent: 'pricing_invisalign',
    requiresHumanFollowUp: false,
    isPossibleEmergency: false,
    leadCapture: { shouldStart: false, shouldContinue: false, suggestedService: 'Invisalign Consultation' },
  };
}

function insuranceReply() {
  return {
    reply:
      "We accept most major PPO dental plans! I'm not able to confirm your specific coverage from here, though — that's best verified by our front desk team. Would you like me to have someone call you to check your plan?",
    intent: 'insurance',
    requiresHumanFollowUp: true,
    isPossibleEmergency: false,
    leadCapture: { shouldStart: false, shouldContinue: false, suggestedService: 'Insurance Verification' },
  };
}

function pricingReply() {
  return {
    reply:
      `Here are some example prices — New Patient Exam & Cleaning: ${PRICES.exam}, Regular Cleaning: ${PRICES.cleaning}, ` +
      `Whitening: ${PRICES.whitening}, Filling: ${PRICES.filling}, Invisalign: ${PRICES.invisalign}. ` +
      `These are estimates — exact cost is confirmed after an exam. Is there a service I can help you book?`,
    intent: 'pricing',
    requiresHumanFollowUp: false,
    isPossibleEmergency: false,
    leadCapture: { shouldStart: false, shouldContinue: false, suggestedService: null },
  };
}

function hoursReply() {
  return {
    reply: `Our hours are: ${CLINIC.hours}. I'm here for questions any time, even outside those hours!`,
    intent: 'hours',
    requiresHumanFollowUp: false,
    isPossibleEmergency: false,
    leadCapture: { shouldStart: false, shouldContinue: false, suggestedService: null },
  };
}

function newPatientReply() {
  return {
    reply: `Welcome to ${CLINIC.name}! As a new patient, we offer a New Patient Exam & Cleaning special for ${PRICES.exam}. Would you like me to help you get that scheduled?`,
    intent: 'newpatient',
    requiresHumanFollowUp: false,
    isPossibleEmergency: false,
    leadCapture: { shouldStart: false, shouldContinue: false, suggestedService: 'New Patient Exam & Cleaning' },
  };
}

function denyReply() {
  return {
    reply: "No problem at all! Is there anything else I can help answer?",
    intent: 'deny',
    requiresHumanFollowUp: false,
    isPossibleEmergency: false,
    leadCapture: { shouldStart: false, shouldContinue: false, suggestedService: null },
  };
}

function fallbackReply() {
  return {
    reply:
      "I don't have that specific detail on hand, and I don't want to guess — our front desk team can confirm and follow up with you directly. Would you like to leave your info so they can reach out?",
    intent: 'unknown',
    requiresHumanFollowUp: true,
    isPossibleEmergency: false,
    leadCapture: { shouldStart: false, shouldContinue: false, suggestedService: null },
  };
}

// Called when the user has just expressed booking intent (fresh message,
// NOT already mid-capture). Starts the deterministic capture sequence.
function startCaptureReply(leadState) {
  const nextField = firstMissingField(leadState.collected);
  const question = nextField ? FIELD_QUESTIONS[nextField](leadState) : null;
  return {
    reply: nextField
      ? `Happy to help! ${question}`
      : "Looks like I already have everything I need — thank you!",
    intent: 'booking_request',
    requiresHumanFollowUp: false,
    isPossibleEmergency: false,
    leadCapture: {
      shouldStart: true,
      shouldContinue: false,
      suggestedService: leadState.collected.service || null,
    },
  };
}

// Called on every turn while leadState.captureActive is true.
// leadState.step (sent by the frontend) tells us what to ask for next,
// or is null when the frontend has determined every field is filled.
function continueCaptureReply(leadState) {
  if (leadState.step) {
    return {
      reply: FIELD_QUESTIONS[leadState.step](leadState),
      intent: 'lead_capture',
      requiresHumanFollowUp: false,
      isPossibleEmergency: false,
      leadCapture: { shouldStart: false, shouldContinue: true, suggestedService: leadState.collected.service || null },
    };
  }

  // All fields filled — build a confirmation summary.
  const c = leadState.collected;
  return {
    reply:
      `Name: ${c.name}. Contact: ${c.contact}. Service: ${c.service}. ` +
      `Preferred date: ${c.date}. Reserved demo time: ${c.time}. Demo confirmation: MSD-${String(Date.now()).slice(-6)}. ` +
      `This is a fictional demo reservation; a real deployment would write the appointment into the clinic scheduling system. Anything else I can help with?`,
    intent: 'lead_capture_complete',
    requiresHumanFollowUp: true,
    isPossibleEmergency: false,
    leadCapture: { shouldStart: false, shouldContinue: false, suggestedService: null },
  };
}

// ---------------------------------------------------------------------------
// 5. MAIN MOCK "AI" ENTRY POINT
//
// This is the single function that would be replaced by a real AI provider
// call in a later step. Everything else in this file can stay the same.
// ---------------------------------------------------------------------------

function generateMockResponse(body) {
  const message = body.message || '';
  const leadState = body.leadState || { step: null, collected: {}, captureActive: false };
  const conversationHistory = body.conversationHistory || [];

  // Make sure collected always has all expected keys.
  leadState.collected = Object.assign(
    { name: null, contact: null, service: null, date: null, time: null },
    leadState.collected || {}
  );

  // --- Mid lead-capture: deterministic code decides what happens next ---
  if (leadState.captureActive) {
    return continueCaptureReply(leadState);
  }

  // --- Fresh message: detect intent first ---
  const intent = detectIntent(message);

  if (intent === 'emergency') return emergencyReply();
  if (intent === 'whitening') return whiteningReply();
  if (intent === 'invisalign') return invisalignReply();
  if (intent === 'insurance') return insuranceReply();
  if (intent === 'pricing') return pricingReply();
  if (intent === 'hours') return hoursReply();
  if (intent === 'newpatient') return newPatientReply();
  if (intent === 'book') return startCaptureReply(leadState);
  if (intent === 'affirm' && lastTurnOfferedBooking(conversationHistory)) return startCaptureReply(leadState);
  if (intent === 'deny') return denyReply();

  return fallbackReply();
}



// ---------------------------------------------------------------------------
// REAL AI LAYER (V3)
//
// The API key is read ONLY from the server process environment. It is never
// sent to public/index.html and never exposed to the browser.
// Deterministic booking and emergency flows remain in code; AI is used for
// free-form receptionist questions when no fixed intent rule applies.
// ---------------------------------------------------------------------------

const AI_INSTRUCTIONS = `You are the virtual receptionist for a FICTIONAL demo clinic called Miami Smile Dental.
Be warm, concise, professional, and practical. Never claim to be a dentist and never diagnose.
Clinic facts: phone ${CLINIC.phone}; hours ${CLINIC.hours}.
Demo prices: exam ${PRICES.exam}; cleaning ${PRICES.cleaning}; whitening ${PRICES.whitening}; filling ${PRICES.filling}; root canal ${PRICES.rootcanal}; crown ${PRICES.crown}; Invisalign ${PRICES.invisalign}; extraction ${PRICES.extraction}; pediatric visit ${PRICES.pediatric}.
If information is not in these facts, say the front desk should confirm it rather than inventing an answer.
If the patient mentions trouble breathing, uncontrolled bleeding, loss of consciousness, severe facial swelling, chest pain, or another potentially life-threatening emergency, tell them to call 911 / local emergency services now. For urgent dental symptoms that are not life-threatening, advise contacting the clinic promptly. Do not give medication dosing.
When useful, offer to help book an appointment. Keep replies under 90 words.`;

function recentConversationText(history, message) {
  const turns = Array.isArray(history) ? history.slice(-8) : [];
  const lines = turns.map((t) => `${t.role === 'assistant' ? 'Receptionist' : 'Patient'}: ${String(t.content || '').slice(0, 800)}`);
  lines.push(`Patient: ${String(message || '').slice(0, 1200)}`);
  return lines.join('\n');
}

function extractResponseText(data) {
  if (!data || !Array.isArray(data.output)) return '';
  for (const item of data.output) {
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part && part.type === 'output_text' && typeof part.text === 'string') return part.text.trim();
    }
  }
  return '';
}

async function realAIReply(message, conversationHistory) {
  if (!OPENAI_API_KEY) return null;
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: AI_INSTRUCTIONS,
      input: recentConversationText(conversationHistory, message),
      max_output_tokens: 220,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${detail.slice(0, 300)}`);
  }
  const data = await response.json();
  const reply = extractResponseText(data);
  if (!reply) throw new Error('OpenAI API returned no text output');
  return {
    reply,
    intent: 'ai_freeform',
    requiresHumanFollowUp: /front desk|confirm|contact the clinic/i.test(reply),
    isPossibleEmergency: false,
    leadCapture: { shouldStart: false, shouldContinue: false, suggestedService: null },
  };
}

async function generateResponse(body) {
  const message = body.message || '';
  const leadState = body.leadState || { step: null, collected: {}, captureActive: false };
  const conversationHistory = body.conversationHistory || [];

  // Booking stays deterministic so AI can never invent an available slot.
  if (leadState.captureActive) return generateMockResponse(body);

  // Safety and common clinic actions also stay deterministic.
  const intent = detectIntent(message);
  if (intent !== 'unknown') return generateMockResponse(body);

  // Free-form questions use real AI when configured; otherwise V3 still works
  // in safe mock mode so the demo never becomes unusable without a key.
  const aiResult = await realAIReply(message, conversationHistory);
  return aiResult || generateMockResponse(body);
}

// ---------------------------------------------------------------------------
// 6. TINY HTTP SERVER (no external dependencies — just Node.js core modules)
// ---------------------------------------------------------------------------

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStaticFile(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  // Friendly staff dashboard route.
  if (filePath === '/dashboard' || filePath === '/dashboard/') filePath = '/dashboard.html';
  filePath = filePath.split('?')[0]; // strip any query string
  const fullPath = path.join(PUBLIC_DIR, filePath);

  // Basic safety check: stay inside the public/ folder
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function handleApiChat(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1e6) req.destroy();
  });
  req.on('end', async () => {
    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
      return;
    }

    try {
      const result = await generateResponse(parsed);
      if (result.intent === 'lead_capture_complete') {
        const saved = saveDemoAppointment(parsed);
        if (saved) result.reply = result.reply.replace(/MSD-\d{6}/, saved.id);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('V4 backend error:', e.message || e);
      // Fail safely: keep the demo usable even if the external AI API is down.
      const fallback = generateMockResponse(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-AI-Fallback': 'true' });
      res.end(JSON.stringify(fallback));
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/chat') {
    handleApiChat(req, res);
    return;
  }
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/appointments') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ appointments: APPOINTMENTS.map(({ fingerprint, ...a }) => a) }));
    return;
  }
  if (req.method === 'GET') {
    serveStaticFile(req, res);
    return;
  }
  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log('');
  console.log('=================================================');
  console.log(`  Miami Smile Dental V4.1 backend is running`);
  console.log(OPENAI_API_KEY ? `  AI mode: REAL AI (${OPENAI_MODEL})` : `  AI mode: SAFE MOCK FALLBACK (no API key configured)`);
  console.log('');
  console.log(`  Open this in your browser:`);
  console.log(`  http://localhost:${PORT}`);
  console.log('');
  console.log('  Press CTRL+C in this window to stop the server.');
  console.log('=================================================');
  console.log('');
});
