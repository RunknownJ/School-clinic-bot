require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(bodyParser.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const AI_MODELS = [
  { name: 'gemini-1.5-flash', type: 'gemini', maxRequests: 15, enabled: true },
  { name: 'gemini-1.5-pro', type: 'gemini', maxRequests: 2, enabled: true },
  { name: 'basic', type: 'basic', maxRequests: 999, enabled: true }
];

let currentModelIndex = 0;
let modelFailCount = new Map();
const requestQueue = [];
let isProcessingQueue = false;
let requestCount = 0;
let lastResetTime = Date.now();

const CLINIC_INFO = {
  location: {
    main: 'Ground Floor beside the Theology Office',
    dental: 'Junior High School Department, near the medical clinic'
  },
  hours: {
    weekdays: 'Monday–Friday: 8:00 AM – 5:00 PM',
    saturday: 'Saturday: 8:00 AM – 12:00 NN (half-day)',
    sunday: 'Closed on Sundays and holidays'
  },
  dentist: {
    schedule: 'Mon-Fri: 8:30-11:30 AM & 1:30-4:30 PM (10 slots per session), Sat: 8:00-11:30 AM',
    extraction_process: 'Get referral from Main Campus clinic → Go to Junior High School dental office',
    anesthesia: 'FREE during tooth extraction'
  },
  doctor: {
    schedule: 'Tuesday, Wednesday, Thursday: 9:00 AM - 12:00 NN',
    outside_hours: 'Students can visit for basic care and first aid'
  },
  medicines: {
    available: ['Paracetamol', 'Dycolsen', 'Dycolgen', 'Loperamide', 'Erceflora', 'Antacid'],
    limit: 'Maximum 2 medicines per person',
    parental_consent: 'Required for minors'
  },
  certificates: {
    issued_for: ['School excuse', 'Fever', 'Asthma attacks', 'Other verified illness']
  },
  referral: {
    hospital: 'Dongon Hospital'
  },
  services: {
    all_free: 'All basic services FREE for enrolled students',
    includes: ['First aid', 'Monitoring', 'Referrals', 'Counseling', 'Preventive care']
  }
};

function getCurrentModel() {
  return AI_MODELS[currentModelIndex];
}

function switchToNextModel() {
  const startIndex = currentModelIndex;
  do {
    currentModelIndex = (currentModelIndex + 1) % AI_MODELS.length;
    const model = AI_MODELS[currentModelIndex];
    if (model.enabled) {
      console.log(`🔄 Switched to: ${model.name}`);
      requestCount = 0;
      lastResetTime = Date.now();
      return model;
    }
  } while (currentModelIndex !== startIndex);
  currentModelIndex = AI_MODELS.findIndex(m => m.type === 'basic');
  return AI_MODELS[currentModelIndex];
}

const userSessions = new Map();
const ADMIN_INACTIVE_TIMEOUT = 15 * 60 * 1000;
const USER_INACTIVE_TIMEOUT = 15 * 60 * 1000;

function getUserSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      conversationHistory: [],
      lastLang: 'en',
      conversationCount: 0,
      lastInteraction: Date.now(),
      adminMode: false,
      lastAdminActivity: null,
      adminInactivityTimer: null,
      hasSeenIntro: false,
      inactivityTimer: null
    });
  }
  
  const session = userSessions.get(userId);
  session.lastInteraction = Date.now();
  session.conversationCount++;
  
  if (session.inactivityTimer) {
    clearTimeout(session.inactivityTimer);
  }
  
  session.inactivityTimer = setTimeout(() => {
    sendInactivityThankYou(userId);
  }, USER_INACTIVE_TIMEOUT);
  
  return session;
}

function sendInactivityThankYou(userId) {
  const session = userSessions.get(userId);
  if (!session || session.adminMode) return;
  
  const thankYouMessages = {
    en: "Thank you for reaching out! 😊\n\nIf you need assistance with the clinic, feel free to message us anytime. We're here to help!\n\nHave a great day! 🌟",
    tl: "Salamat sa pag-message! 😊\n\nKung kailangan mo ng tulong, mag-message ka lang anytime. Nandito kami!\n\nMagandang araw! 🌟",
    ceb: "Salamat sa pag-message! 😊\n\nKung kinahanglan nimo og tabang, message lang anytime. Naa mi dinhi!\n\nMaayong adlaw! 🌟"
  };
  
  sendTextMessage(userId, thankYouMessages[session.lastLang || 'en']);
  console.log(`⏰ Sent thank you to user ${userId}`);
}

function enableAdminMode(userId) {
  const session = getUserSession(userId);
  session.adminMode = true;
  session.lastAdminActivity = Date.now();
  
  if (session.inactivityTimer) {
    clearTimeout(session.inactivityTimer);
    session.inactivityTimer = null;
  }
  
  if (session.adminInactivityTimer) {
    clearTimeout(session.adminInactivityTimer);
  }
  
  console.log(`✅ Admin mode ON for ${userId}`);
}

function updateAdminActivity(userId) {
  const session = userSessions.get(userId);
  if (session && session.adminMode) {
    session.lastAdminActivity = Date.now();
    
    if (session.adminInactivityTimer) {
      clearTimeout(session.adminInactivityTimer);
    }
    
    session.adminInactivityTimer = setTimeout(() => {
      disableAdminMode(userId, true);
    }, ADMIN_INACTIVE_TIMEOUT);
  }
}

function disableAdminMode(userId, autoDisabled = false) {
  const session = userSessions.get(userId);
  if (session && session.adminMode) {
    session.adminMode = false;
    session.lastAdminActivity = null;
    
    if (session.adminInactivityTimer) {
      clearTimeout(session.adminInactivityTimer);
      session.adminInactivityTimer = null;
    }
    
    console.log(`🔴 Admin mode OFF for ${userId} ${autoDisabled ? '(auto)' : ''}`);
    
    if (autoDisabled) {
      const reactivationMsg = {
        en: "Thank you for your patience! 😊\n\nMeddy is active again. How can I assist you?",
        tl: "Salamat sa pasensya! 😊\n\nSi Meddy aktibo na. Paano kita matutulungan?",
        ceb: "Salamat sa pailob! 😊\n\nSi Meddy aktibo na. Unsaon nako pagtabang?"
      };
      
      sendTextMessage(userId, reactivationMsg[session.lastLang || 'en']);
      setTimeout(() => sendMainMenu(userId, session.lastLang, true), 1000);
    }
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of userSessions.entries()) {
    if (now - session.lastInteraction > 1800000) {
      if (session.adminInactivityTimer) clearTimeout(session.adminInactivityTimer);
      if (session.inactivityTimer) clearTimeout(session.inactivityTimer);
      userSessions.delete(userId);
      console.log(`🧹 Cleaned session ${userId}`);
    }
  }
}, 300000);

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    body.entry.forEach(entry => {
      const webhookEvent = entry.messaging[0];
      const senderId = webhookEvent.sender.id;

      if (webhookEvent.message) {
        handleMessage(senderId, webhookEvent.message);
      } else if (webhookEvent.postback) {
        handlePostback(senderId, webhookEvent.postback);
      }
    });
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

async function handleMessage(senderId, message) {
  const text = message.text?.trim() || '';
  if (!text) return;

  const session = getUserSession(senderId);

  const talkToAdminKeywords = ['talk to admin', 'speak to admin', 'contact admin', 
                                'magsalita sa admin', 'makipag-usap sa admin',
                                'pakigsulti sa admin'];
  
  if (talkToAdminKeywords.some(kw => text.toLowerCase().includes(kw))) {
    enableAdminMode(senderId);
    
    const adminModeMsg = {
      en: "Our customer support team has received your concern and will get back to you as soon as possible. 😊\n\nYour patience means a lot to us. 🙏",
      tl: "Natanggap na ng support team ang concern mo at tutugon sa lalong madaling panahon. 😊\n\nSalamat sa pasensya! 🙏",
      ceb: "Nadawat na sa support team ang concern nimo ug motubag dayon. 😊\n\nSalamat sa pailob! 🙏"
    };
    
    sendTextMessage(senderId, adminModeMsg[session.lastLang] || adminModeMsg.en);
    updateAdminActivity(senderId);
    return;
  }

  if (session.adminMode) {
    updateAdminActivity(senderId);
    console.log(`💬 Admin mode active for ${senderId}`);
    return;
  }

  try {
    sendTypingIndicator(senderId, true);
    const lang = detectLanguageFallback(text);
    session.lastLang = lang;

    if (!session.hasSeenIntro) {
      const introMessages = {
        en: "Hello! 👋 I'm Meddy, the Saint Joseph College Clinic chatbot. How can I help you today? 😊",
        tl: "Kumusta! 👋 Ako si Meddy, ang chatbot ng clinic. Paano kita matutulungan? 😊",
        ceb: "Kumusta! 👋 Ako si Meddy, ang chatbot sa clinic. Unsaon nako pagtabang? 😊"
      };
      
      sendTextMessage(senderId, introMessages[lang]);
      session.hasSeenIntro = true;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    const response = await queueAIRequest(text, session, lang);
    
    session.conversationHistory.push({ user: text, bot: response, timestamp: Date.now() });
    if (session.conversationHistory.length > 5) {
      session.conversationHistory = session.conversationHistory.slice(-5);
    }

    sendTypingIndicator(senderId, false);
    sendTextMessage(senderId, response);
    setTimeout(() => sendMainMenu(senderId, lang, false), 1500);

  } catch (error) {
    console.error('❌ ERROR:', error.message);
    sendTypingIndicator(senderId, false);
    
    const errorMsg = session.lastLang === 'tl' 
      ? '⚠️ May problema sa sistema. Subukan ulit.'
      : session.lastLang === 'ceb'
      ? '⚠️ Naa problema. Suway-i usab.'
      : '⚠️ Error occurred. Please try again.';
    
    sendTextMessage(senderId, errorMsg);
    setTimeout(() => sendMainMenu(senderId, session.lastLang || 'en', false), 1000);
  }
}

async function queueAIRequest(userMessage, session, lang) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ userMessage, session, lang, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (isProcessingQueue || requestQueue.length === 0) return;
  
  isProcessingQueue = true;
  
  while (requestQueue.length > 0) {
    const currentModel = getCurrentModel();
    const now = Date.now();
    
    if (now - lastResetTime >= 60000) {
      requestCount = 0;
      lastResetTime = now;
    }
    
    if (requestCount >= currentModel.maxRequests) {
      const waitTime = 60000 - (now - lastResetTime);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      requestCount = 0;
      lastResetTime = Date.now();
    }
    
    const request = requestQueue.shift();
    try {
      const response = await getAIResponse(request.userMessage, request.session, request.lang);
      requestCount++;
      modelFailCount.set(currentModel.name, 0);
      request.resolve(response);
    } catch (error) {
      const failCount = (modelFailCount.get(currentModel.name) || 0) + 1;
      modelFailCount.set(currentModel.name, failCount);
      
      if (error.message.includes('429') || failCount >= 3) {
        switchToNextModel();
        requestQueue.unshift(request);
        requestCount = 0;
      } else {
        request.reject(error);
      }
    }
  }
  
  isProcessingQueue = false;
}

async function getAIResponse(userMessage, session, detectedLang) {
  const currentModel = getCurrentModel();
  
  if (currentModel.type === 'gemini') {
    return await getGeminiResponse(userMessage, session, detectedLang, currentModel.name);
  } else {
    return getBasicResponse(userMessage, session, detectedLang);
  }
}

async function getGeminiResponse(userMessage, session, detectedLang, modelName) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  const model = genAI.getGenerativeModel({ model: modelName });
  
  let conversationContext = '';
  if (session.conversationHistory.length > 0) {
    conversationContext = '\n\nRECENT CONVERSATION:\n';
    session.conversationHistory.slice(-3).forEach(ex => {
      conversationContext += `User: ${ex.user}\nMeddy: ${ex.bot}\n`;
    });
  }

  const languageInstruction = detectedLang === 'ceb' 
    ? 'Respond in Bisaya/Cebuano.' 
    : detectedLang === 'tl' 
    ? 'Respond in Tagalog.' 
    : 'Respond in English.';

  const prompt = `You are Meddy, Saint Joseph College Clinic assistant. DO NOT introduce yourself in every response.

${languageInstruction}

CLINIC INFO:
Location: Ground Floor beside Theology Office | Dental: JHS Department
Hours: Mon-Fri 8AM-5PM, Sat 8AM-12NN, Closed Sun/holidays
Dentist: Mon-Fri 8:30-11:30AM & 1:30-4:30PM, Sat 8-11:30AM (10 slots, FREE anesthesia)
Doctor: Tue/Wed/Thu 9AM-12NN (basic care available anytime)
Medicines (FREE): Paracetamol, Dycolsen, Dycolgen, Loperamide, Erceflora, Antacid (max 2)
Tooth Extraction: Main Clinic → referral slip → Dental Clinic (JHS)
Certificates: For school excuse, fever, asthma, verified illness
Referral Hospital: Dongon Hospital
Services (FREE): First aid, monitoring, referrals, counseling

${conversationContext}

User: ${userMessage}

Respond in 2-4 sentences. Be helpful and friendly. Use emojis. Base answer on clinic info only.`;

  const result = await model.generateContent(prompt);
  return result.response.text();
}

function getBasicResponse(userMessage, session, lang) {
  const lowerMsg = userMessage.toLowerCase();
  
  const responses = {
    en: {
      greeting: "Hi! 😊 How can I help you today?",
      location: "📍 Main: Ground Floor beside Theology Office\nDental: JHS Department",
      hours: "🕐 Mon-Fri: 8AM-5PM | Sat: 8AM-12NN | Closed Sun/holidays",
      doctor: "👨‍⚕️ Doctor: Tue/Wed/Thu 9AM-12NN | Basic care anytime",
      dentist: "🦷 Mon-Fri: 8:30-11:30AM & 1:30-4:30PM | Sat: 8-11:30AM\n10 slots | FREE anesthesia",
      medicines: "💊 FREE: Paracetamol, Dycolsen, Dycolgen, Loperamide, Erceflora, Antacid\nMax 2 | Parental consent for minors",
      extraction: "🦷 Steps:\n1. Main Clinic\n2. Get referral\n3. Dental Clinic (JHS)\n4. FREE anesthesia!",
      certificate: "📋 For school excuse, fever, asthma, verified illness",
      emergency: "🚨 Tell teacher → Clinic → First aid → Hospital if needed",
      referral: "🏥 Dongon Hospital | Emergency: go direct | Regular: clinic first",
      services: "✨ FREE: First aid, monitoring, referrals, counseling, preventive care",
      default: "I can help with:\n📍 Location\n🕐 Hours\n👨‍⚕️ Doctor/Dentist\n💊 Medicines\n🦷 Extraction\n📋 Certificates\n🏥 Referrals\n\nType 'talk to admin' for staff"
    },
    tl: {
      greeting: "Kumusta! 😊 Paano kita matutulungan?",
      location: "📍 Main: Ground Floor beside Theology Office\nDental: JHS Department",
      hours: "🕐 Lun-Biy: 8AM-5PM | Sab: 8AM-12NN | Sarado Linggo/holiday",
      doctor: "👨‍⚕️ Doktor: Mar/Miy/Huw 9AM-12NN | Basic care anytime",
      dentist: "🦷 Lun-Biy: 8:30-11:30AM & 1:30-4:30PM | Sab: 8-11:30AM\n10 slots | LIBRE anesthesia",
      medicines: "💊 LIBRE: Paracetamol, Dycolsen, Dycolgen, Loperamide, Erceflora, Antacid\nMax 2 | Consent ng magulang",
      extraction: "🦷 Steps:\n1. Main Clinic\n2. Kuha referral\n3. Dental Clinic (JHS)\n4. LIBRE anesthesia!",
      certificate: "📋 Para sa excuse, lagnat, asthma, sakit",
      emergency: "🚨 Sabihin sa teacher → Clinic → First aid → Hospital kung kailangan",
      referral: "🏥 Dongon Hospital | Emergency: diretso | Regular: clinic muna",
      services: "✨ LIBRE: First aid, monitoring, referrals, counseling, preventive care",
      default: "Matutulungan kita:\n📍 Location\n🕐 Oras\n👨‍⚕️ Doctor/Dentist\n💊 Gamot\n🦷 Extraction\n📋 Certificates\n🏥 Referrals\n\nType 'talk to admin' para sa staff"
    },
    ceb: {
      greeting: "Kumusta! 😊 Unsaon nako pagtabang?",
      location: "📍 Main: Ground Floor beside Theology Office\nDental: JHS Department",
      hours: "🕐 Lun-Biy: 8AM-5PM | Sab: 8AM-12NN | Sarado Domingo/holiday",
      doctor: "👨‍⚕️ Doktor: Mar/Miy/Huw 9AM-12NN | Basic care anytime",
      dentist: "🦷 Lun-Biy: 8:30-11:30AM & 1:30-4:30PM | Sab: 8-11:30AM\n10 slots | LIBRE anesthesia",
      medicines: "💊 LIBRE: Paracetamol, Dycolsen, Dycolgen, Loperamide, Erceflora, Antacid\nMax 2 | Consent sa ginikanan",
      extraction: "🦷 Steps:\n1. Main Clinic\n2. Kuha referral\n3. Dental Clinic (JHS)\n4. LIBRE anesthesia!",
      certificate: "📋 Para sa excuse, hilanat, asthma, sakit",
      emergency: "🚨 Sulti sa teacher → Clinic → First aid → Hospital kung kinahanglan",
      referral: "🏥 Dongon Hospital | Emergency: direkta | Regular: clinic una",
      services: "✨ LIBRE: First aid, monitoring, referrals, counseling, preventive care",
      default: "Makatabang ko:\n📍 Location\n🕐 Oras\n👨‍⚕️ Doctor/Dentist\n💊 Tambal\n🦷 Extraction\n📋 Certificates\n🏥 Referrals\n\nType 'talk to admin' para sa staff"
    }
  };

  const r = responses[lang] || responses.en;

  if (/(hi|hello|hey|kumusta)/i.test(lowerMsg)) return r.greeting;
  if (/(where|location|asa|saan|diin)/i.test(lowerMsg)) return r.location;
  if (/(hours|time|schedule|oras|open)/i.test(lowerMsg) && !/(doctor|dentist)/i.test(lowerMsg)) return r.hours;
  if (/(doctor|doktor)/i.test(lowerMsg)) return r.doctor;
  if (/(dentist|dental|ngipon)/i.test(lowerMsg)) return r.dentist;
  if (/(medicine|gamot|tambal)/i.test(lowerMsg)) return r.medicines;
  if (/(extraction|bunot|tanggal)/i.test(lowerMsg)) return r.extraction;
  if (/(certificate|cert|excuse)/i.test(lowerMsg)) return r.certificate;
  if (/(emergency|emerhensya|urgent)/i.test(lowerMsg)) return r.emergency;
  if (/(referral|hospital|ospital)/i.test(lowerMsg)) return r.referral;
  if (/(service|offer)/i.test(lowerMsg)) return r.services;
  
  return r.default;
}

function detectLanguageFallback(text) {
  const lowerText = text.toLowerCase();
  
  const bisayaWords = ['unsa', 'kanus-a', 'asa', 'naa', 'wala', 'tambal', 'ngipon', 
                       'doktor', 'kumusta', 'pila', 'libre', 'diin'];
  const tagalogWords = ['kumusta', 'ako', 'ang', 'ng', 'sa', 'po', 'salamat', 
                        'ano', 'kelan', 'paano', 'gamot', 'sakit', 'ngipin', 'saan'];
  
  const bisayaCount = bisayaWords.filter(w => lowerText.includes(w)).length;
  const tagalogCount = tagalogWords.filter(w => lowerText.includes(w)).length;
  
  if (bisayaCount >= 1) return 'ceb';
  if (tagalogCount >= 2) return 'tl';
  return 'en';
}

function handlePostback(senderId, postback) {
  const payload = postback.payload;
  const session = getUserSession(senderId);

  if (session.adminMode) {
    updateAdminActivity(senderId);
    return;
  }

  if (payload === 'MAIN_MENU') {
    sendMainMenu(senderId, 'en', false);
    return;
  }

  if (payload === 'TALK_TO_ADMIN') {
    enableAdminMode(senderId);
    const msg = "Our support team has been notified and will respond soon. 😊\n\nYour patience means a lot! 🙏";
    sendTextMessage(senderId, msg);
    updateAdminActivity(senderId);
    return;
  }

  const messageMap = {
    'CLINIC_INFO': 'clinic location and hours',
    'DOCTOR_SCHEDULE': 'doctor schedule',
    'DENTAL_SERVICES': 'dental services',
    'MEDICINES': 'available medicines',
    'CERTIFICATES': 'medical certificate',
    'REFERRALS': 'hospital referrals',
    'EMERGENCY': 'emergency procedures',
    'OTHER_SERVICES': 'other services',
    'TOOTH_EXTRACTION': 'tooth extraction'
  };

  const simulatedMessage = messageMap[payload];
  if (simulatedMessage) {
    session.lastLang = 'en';
    handleMessage(senderId, { text: simulatedMessage });
  } else {
    sendMainMenu(senderId, 'en', false);
  }
}

function sendMainMenu(senderId, lang = 'en', skipIfAdmin = true) {
  const session = getUserSession(senderId);
  
  if (skipIfAdmin && session && session.adminMode) return;

  const menuText = "So we can help you better, please choose an option from the menu. 📱";

  const quickReplies = [
    { title: "📍 Clinic Info", payload: "CLINIC_INFO" },
    { title: "👨‍⚕️ Doctor", payload: "DOCTOR_SCHEDULE" },
    { title: "🦷 Dental", payload: "DENTAL_SERVICES" },
    { title: "💊 Medicines", payload: "MEDICINES" },
    { title: "📋 Certificate", payload: "CERTIFICATES" },
    { title: "🏥 Referrals", payload: "REFERRALS" },
    { title: "🚨 Emergency", payload: "EMERGENCY" },
    { title: "✨ Other Services", payload: "OTHER_SERVICES" },
    { title: "👨‍💼 Talk to Admin", payload: "TALK_TO_ADMIN" }
  ];

  const formattedReplies = quickReplies.map(item => ({
    content_type: "text",
    title: item.title,
    payload: item.payload
  }));

  sendMessage(senderId, { text: menuText, quick_replies: formattedReplies });
}

function sendTypingIndicator(senderId, isTyping) {
  const action = isTyping ? 'typing_on' : 'typing_off';
  axios.post(`https://graph.facebook.com/v18.0/me/messages`, {
    recipient: { id: senderId },
    sender_action: action
  }, {
    params: { access_token: PAGE_ACCESS_TOKEN }
  }).catch(err => {
    if (err.response?.data?.error?.code !== 100) {
      console.error('⚠️ Typing error:', err.message);
    }
  });
}

function sendTextMessage(senderId, text) {
  sendMessage(senderId, { text });
}

function sendMessage(senderId, message) {
  axios.post(`https://graph.facebook.com/v18.0/me/messages`, {
    recipient: { id: senderId },
    message: message,
    messaging_type: 'RESPONSE'
  }, {
    params: { access_token: PAGE_ACCESS_TOKEN }
  })
  .then(() => console.log('✅ Message sent'))
  .catch(error => {
    const errorData = error.response?.data?.error;
    const errorCode = errorData?.code;
    const errorSubcode = errorData?.error_subcode;
    
    if (errorCode === 100 && errorSubcode === 2018001) {
      console.log(`⚠️ User ${senderId} unreachable`);
      return;
    }
    
    if (errorCode === 100) {
      console.log(`⚠️ Cannot send to ${senderId}`);
      return;
    }
    
    console.error('❌ Send error:', errorData || error.message);
  });
}

app.post('/admin/enable/:userId', (req, res) => {
  enableAdminMode(req.params.userId);
  res.json({ success: true, message: 'Admin mode enabled' });
});

app.post('/admin/disable/:userId', (req, res) => {
  disableAdminMode(req.params.userId, false);
  res.json({ success: true, message: 'Admin mode disabled' });
});

app.get('/admin/status/:userId', (req, res) => {
  const session = userSessions.get(req.params.userId);
  res.json(session ? {
    exists: true,
    adminMode: session.adminMode,
    lastLang: session.lastLang,
    conversationCount: session.conversationCount
  } : { exists: false });
});

app.get('/admin/sessions', (req, res) => {
  const sessions = [];
  for (const [userId, session] of userSessions.entries()) {
    sessions.push({
      userId,
      adminMode: session.adminMode,
      lastLang: session.lastLang,
      conversationCount: session.conversationCount,
      lastInteraction: new Date(session.lastInteraction).toISOString()
    });
  }
  res.json({ totalSessions: sessions.length, sessions });
});

app.get('/admin/ai-status', (req, res) => {
  const currentModel = getCurrentModel();
  res.json({
    currentModel: currentModel.name,
    modelType: currentModel.type,
    requestCount: requestCount,
    maxRequests: currentModel.maxRequests,
    queueLength: requestQueue.length,
    allModels: AI_MODELS.map(m => ({
      name: m.name,
      type: m.type,
      enabled: m.enabled,
      failCount: modelFailCount.get(m.name) || 0
    }))
  });
});

app.post('/admin/switch-model/:index', (req, res) => {
  const index = parseInt(req.params.index);
  if (index >= 0 && index < AI_MODELS.length) {
    currentModelIndex = index;
    requestCount = 0;
    lastResetTime = Date.now();
    const model = AI_MODELS[index];
    console.log(`🔄 Switched to: ${model.name}`);
    res.json({ success: true, currentModel: model });
  } else {
    res.status(400).json({ success: false, error: 'Invalid index' });
  }
});

app.get('/', (req, res) => {
  const currentModel = getCurrentModel();
  res.send(`✅ Meddy Chatbot Running! 🏥\n\nModel: ${currentModel.name}\nRequests: ${requestCount}/${currentModel.maxRequests}`);
});

app.get('/test-ai', async (req, res) => {
  const testMessage = req.query.message || 'When is the dentist available?';
  const lang = req.query.lang || 'en';
  
  try {
    const session = { conversationHistory: [], lastLang: lang };
    const response = await getAIResponse(testMessage, session, lang);
    const currentModel = getCurrentModel();
    
    res.json({
      success: true,
      userMessage: testMessage,
      aiResponse: response,
      currentModel: currentModel.name,
      modelType: currentModel.type
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/test-models', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(400).json({ success: false, error: 'GEMINI_API_KEY not configured' });
    }

    const response = await axios.get(
      'https://generativelanguage.googleapis.com/v1beta/models',
      { params: { key: GEMINI_API_KEY } }
    );
    
    const modelNames = response.data.models
      .filter(m => m.supportedGenerationMethods.includes('generateContent'))
      .map(m => ({
        name: m.name.replace('models/', ''),
        displayName: m.displayName,
        description: m.description
      }));
    
    res.json({ success: true, availableModels: modelNames });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const currentModel = getCurrentModel();
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🤖 AI: ${GEMINI_API_KEY ? 'ENABLED ✅' : 'BASIC MODE ⚠️'}`);
  console.log(`🔧 Model: ${currentModel.name} (${currentModel.type})`);
  console.log(`⏱️  Rate: ${currentModel.maxRequests} req/min`);
});