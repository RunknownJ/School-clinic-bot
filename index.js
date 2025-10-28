require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(bodyParser.json());

// UPDATED: Support multiple page tokens
const PAGE_ACCESS_TOKEN_1 = process.env.PAGE_ACCESS_TOKEN_1;
const PAGE_ACCESS_TOKEN_2 = process.env.PAGE_ACCESS_TOKEN_2;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Map page IDs to their tokens
const PAGE_TOKENS = {
  '118188723419449': PAGE_ACCESS_TOKEN_2,
  '779719758563529': PAGE_ACCESS_TOKEN_1
};

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// AI Model Configuration with multiple fallbacks
const AI_MODELS = [
  {
    name: 'gemini-2.5-flash',
    type: 'gemini',
    maxRequests: 15,
    enabled: true
  },
  {
    name: 'gemini-2.5-flash-lite',
    type: 'gemini',
    maxRequests: 15,
    enabled: true
  },
  {
    name: 'gemini-2.0-flash-001',
    type: 'gemini',
    maxRequests: 15,
    enabled: true
  },
  {
    name: 'basic',
    type: 'basic',
    maxRequests: 999,
    enabled: true
  }
];

let currentModelIndex = 0;
let modelFailCount = new Map();

// Rate limiting for AI API
const requestQueue = [];
let isProcessingQueue = false;
let requestCount = 0;
let lastResetTime = Date.now();

// Saint Joseph College Clinic Information
const CLINIC_INFO = {
  location: {
    main: 'Ground Floor beside the Theology Office',
    dental: 'Junior High School Department, near the medical clinic'
  },
hours: {
  weekdays: 'Monday–Friday: 8:30 AM – 12:00 NN, 1:30 PM – 5:30 PM',
  weekdays_college: 'College Clinic: Extended until 8:30 PM',
  saturday: 'Saturday: 8:00 AM – 12:00 NN (half-day)',
  sunday: 'Closed on Sundays and holidays'
},
  dentist: {
    schedule: 'Mon-Fri: 8:30-11:30 AM & 1:30-4:30 PM (10 slots per session), Sat: 8:00-11:30 AM',
    extraction_process: 'Get referral from Main Campus clinic → Go to Junior High School dental office for tooth extraction',
    anesthesia: 'FREE during tooth extraction'
  },
  doctor: {
    schedule: 'Tuesday, Wednesday, Thursday: 9:00 AM - 12:00 NN',
    outside_hours: 'Students can visit for basic care and first aid. Serious cases will receive referral slips.'
  },
  medicines: {
    available: ['Paracetamol', 'Dycolsen', 'Dycolgen', 'Loperamide', 'Erceflora', 'Antacid'],
    limit: 'Maximum 2 medicines per person',
    type: 'Over-the-counter medicines, no prescription required',
    parental_consent: 'Required for minors before dispensing medicine',
    prescription: 'Prescription medicines require valid doctor prescription'
  },
  certificates: {
    issued_for: ['School excuse', 'Fever', 'Asthma attacks', 'Other verified illness'],
    requirement: 'Valid medical reasons confirmed by clinic staff'
  },
  referral: {
    hospital: 'Dongon Hospital',
    emergency: 'Can go directly to hospital',
    regular: 'Visit clinic first for proper documentation',
    refusal_slip: 'Given when clinic cannot accommodate'
  },
  services: {
    all_free: 'All basic services and common medicines are FREE for enrolled students',
    includes: ['First aid treatment', 'Chronic condition monitoring', 'Hospital referrals', 'Health counseling', 'Preventive care tips']
  },
  emergency: {
    procedure: 'Inform teacher/staff → Escorted to clinic → First aid → Hospital referral if needed',
    handles: ['Injuries', 'Fainting', 'Fever', 'Asthma attacks', 'Other urgent conditions']
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
      console.log(`🔄 Switched to model: ${model.name} (${model.type})`);
      requestCount = 0;
      lastResetTime = Date.now();
      return model;
    }
  } while (currentModelIndex !== startIndex);
  
  currentModelIndex = AI_MODELS.findIndex(m => m.type === 'basic');
  console.log('⚠️ All AI models unavailable, using basic mode');
  return AI_MODELS[currentModelIndex];
}

const userSessions = new Map();
const ADMIN_INACTIVE_TIMEOUT = 15 * 60 * 1000;

function getUserSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      conversationHistory: [],
      lastIntent: null,
      lastLang: 'en',
      conversationCount: 0,
      lastInteraction: Date.now(),
      menuLevel: 'main',
      adminMode: false,
      lastAdminActivity: null,
      adminInactivityTimer: null,
      conversationEnded: false,
      hasIntroduced: false,
      pageId: null
    });
  }
  
  const session = userSessions.get(userId);
  session.lastInteraction = Date.now();
  session.conversationCount++;
  
  return session;
}

// UPDATED: Get the correct token for a user based on their page
function getPageTokenForUser(userId) {
  const session = userSessions.get(userId);
  if (session && session.pageId && PAGE_TOKENS[session.pageId]) {
    return PAGE_TOKENS[session.pageId];
  }
  // Fallback to first token
  return PAGE_ACCESS_TOKEN_1;
}

function enableAdminMode(userId, silent = false) {
  const session = getUserSession(userId);
  
  if (session.adminMode) {
    updateAdminActivity(userId);
    return;
  }
  
  session.adminMode = true;
  session.lastAdminActivity = Date.now();
  
  if (session.adminInactivityTimer) {
    clearTimeout(session.adminInactivityTimer);
  }
  
  session.adminInactivityTimer = setTimeout(() => {
    disableAdminMode(userId, true);
  }, ADMIN_INACTIVE_TIMEOUT);
  
  console.log(`✅ Admin mode ENABLED for user ${userId}`);
  
  if (!silent) {
    const adminModeMsg = {
      en: "👨‍💼 Admin mode activated! A clinic staff member will respond to you shortly. Meddy is now paused.\n\n(Meddy will automatically reactivate after 15 minutes of staff inactivity)",
      tl: "👨‍💼 Admin mode activated! Sasagutin ka ng clinic staff. Si Meddy ay naka-pause na.\n\n(Si Meddy ay babalik pagkatapos ng 15 minuto ng walang staff activity)",
      ceb: "👨‍💼 Admin mode activated! Tubagon ka sa clinic staff. Si Meddy gi-pause na.\n\n(Si Meddy mobalik human sa 15 minuto nga walay staff activity)"
    };
    
    sendTextMessage(userId, adminModeMsg[session.lastLang] || adminModeMsg.en);
  }
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
    
    console.log(`🔄 Admin activity updated for user ${userId}`);
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
    
    console.log(`🔴 Admin mode DISABLED for user ${userId} ${autoDisabled ? '(auto)' : '(manual)'}`);
    
    if (autoDisabled) {
      // Reset conversation state when admin mode ends
      session.lastInteraction = Date.now();
      session.conversationEnded = false;
      
      const lang = session.lastLang || 'en';
      const reactivationMsg = {
        en: "🤖 Meddy is now active again! Feel free to ask me questions about the clinic, or type 'talk to admin' if you need to speak with a staff member.",
        tl: "🤖 Si Meddy ay aktibo na ulit! Magtanong ka tungkol sa clinic, o i-type ang 'talk to admin' kung kailangan mo ng staff.",
        ceb: "🤖 Si Meddy aktibo na usab! Pangutana ko bahin sa clinic, o i-type ang 'talk to admin' kung kinahanglan mo ang staff."
      };
      
      sendTextMessage(userId, reactivationMsg[lang] || reactivationMsg.en);
      setTimeout(() => {
        sendMainMenu(userId, lang);
      }, 1000);
    }
  }
}

// REMOVED: Automatic inactivity goodbye interval
// Clean up old sessions only (30+ minutes)
setInterval(() => {
  const now = Date.now();
  
  for (const [userId, session] of userSessions.entries()) {
    const inactiveDuration = now - session.lastInteraction;
    
    // Clean up very old sessions (30+ minutes)
    if (inactiveDuration > 1800000) {
      if (session.adminInactivityTimer) {
        clearTimeout(session.adminInactivityTimer);
      }
      userSessions.delete(userId);
      console.log(`🧹 Cleaned up old session for user ${userId}`);
    }
  }
}, 60000);

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
      const pageId = entry.id;

      // UPDATED: Store the page ID in session
      const session = getUserSession(senderId);
      session.pageId = pageId;

      if (webhookEvent.message) {
        // Check if this is an echo message (from the page itself)
        if (webhookEvent.message.is_echo) {
          console.log('📤 Echo message (from page), skipping');
          return;
        }
        
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

app.post('/webhook/admin-reply', (req, res) => {
  const { userId } = req.body;
  
  if (userId) {
    console.log(`👨‍💼 Admin replied to user ${userId}, enabling admin mode`);
    enableAdminMode(userId, true);
    res.json({ success: true, message: 'Admin mode enabled' });
  } else {
    res.status(400).json({ success: false, error: 'userId required' });
  }
});

async function handleMessage(senderId, message) {
  const text = message.text?.trim() || '';
  if (!text) return;

  const session = getUserSession(senderId);

  // ✅ CHECK ADMIN MODE FIRST
  if (session.adminMode) {
    updateAdminActivity(senderId);
    console.log(`💬 Message from user ${senderId} in admin mode - bot paused`);
    return;
  }

  // ✅ DETECT FAREWELL/THANK YOU MESSAGES
  const thankYouKeywords = ['thank', 'thanks', 'salamat', 'salamat kaayo', 'thank you', 'ty', 'tysm', 'thnks', 'thnx'];
  const goodbyeKeywords = ['bye', 'goodbye', 'good bye', 'see you', 'paalam', 'sige', 'adios', 'hangtod', 'bye bye', 'bbye'];
  
  const lowerText = text.toLowerCase();
  
  // Check if message is primarily a thank you or goodbye
  const isThankYou = thankYouKeywords.some(keyword => 
    lowerText === keyword || 
    lowerText.startsWith(keyword + ' ') ||
    lowerText.startsWith(keyword + ',') ||
    lowerText.endsWith(' ' + keyword) ||
    lowerText.endsWith(', ' + keyword)
  );
  
  const isGoodbye = goodbyeKeywords.some(keyword => 
    lowerText.includes(keyword)
  );

  // ✅ NEW: Check if conversation ended but user is starting a new conversation
  if (session.conversationEnded && !isThankYou && !isGoodbye) {
    console.log(`🔄 User ${senderId} starting new conversation after goodbye`);
    session.conversationEnded = false;
    session.conversationHistory = []; // Reset history for fresh start
    // Continue processing the message below
  }
  
  // ✅ ONLY respond with farewell if user explicitly says goodbye/thank you
  if (isThankYou || isGoodbye) {
    session.conversationEnded = true;
    
    const farewellMsg = {
      en: "You're welcome! Thank you for messaging the Saint Joseph College Clinic. Stay healthy! 😊\n\nFeel free to reach out anytime you need assistance. Take care! 👋",
      tl: "Walang anuman! Salamat sa pag-message sa Saint Joseph College Clinic. Mag-ingat ka! 😊\n\nBumalik ka lang kung kailangan mo ng tulong. Ingat! 👋",
      ceb: "Walay sapayan! Salamat sa pag-message sa Saint Joseph College Clinic. Pag-amping! 😊\n\nBalik lang kung kinahanglan nimo og tabang. Amping! 👋"
    };
    
    sendTextMessage(senderId, farewellMsg[session.lastLang] || farewellMsg.en);
    console.log(`👋 User ${senderId} said goodbye - conversation ended`);
    return;
  }

  // ✅ HANDLE "TALK TO ADMIN" REQUEST
  const talkToAdminKeywords = ['talk to admin', 'speak to admin', 'contact admin', 
                                'magsalita sa admin', 'makipag-usap sa admin',
                                'pakigsulti sa admin', 'gusto ko admin', 'talk to staff',
                                'speak to staff', 'contact staff'];
  
  if (talkToAdminKeywords.some(keyword => lowerText.includes(keyword))) {
    enableAdminMode(senderId);
    updateAdminActivity(senderId);
    return;
  }

  // ✅ NORMAL MESSAGE PROCESSING
  try {
    sendTypingIndicator(senderId, true);
    console.log('📨 User message:', text);

    const lang = detectLanguageFallback(text);
    session.lastLang = lang;

    const response = await queueAIRequest(text, session, lang);
    console.log('🤖 AI response:', response);
    
    session.conversationHistory.push({
      user: text,
      bot: response,
      timestamp: Date.now()
    });

    if (session.conversationHistory.length > 5) {
      session.conversationHistory = session.conversationHistory.slice(-5);
    }

    sendTypingIndicator(senderId, false);
    sendTextMessage(senderId, response);

    setTimeout(() => {
      sendMainMenu(senderId, lang);
    }, 1500);

  } catch (error) {
    console.error('❌ ERROR:', error.message);
    sendTypingIndicator(senderId, false);
    
    const errorMsg = session.lastLang === 'tl' 
      ? '⚠️ Pasensya na, may problema sa sistema. Pakisubukan ulit.'
      : session.lastLang === 'ceb'
      ? '⚠️ Pasensya na, naa problema sa sistema. Palihug suway-i usab.'
      : '⚠️ Sorry, I encountered an error. Please try again.';
    
    sendTextMessage(senderId, errorMsg);
    setTimeout(() => sendMainMenu(senderId, session.lastLang || 'en'), 1000);
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
      console.log('🔄 Rate limit counter reset');
    }
    
    if (requestCount >= currentModel.maxRequests) {
      const waitTime = 60000 - (now - lastResetTime);
      console.log(`⏳ Rate limit reached for ${currentModel.name}. Waiting ${Math.ceil(waitTime / 1000)}s...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      requestCount = 0;
      lastResetTime = Date.now();
    }
    
    const request = requestQueue.shift();
    try {
      const response = await getAIResponse(
        request.userMessage,
        request.session,
        request.lang
      );
      requestCount++;
      console.log(`📊 AI requests: ${requestCount}/${currentModel.maxRequests} this minute (${currentModel.name})`);
      
      modelFailCount.set(currentModel.name, 0);
      
      request.resolve(response);
    } catch (error) {
      console.error(`❌ Error with ${currentModel.name}:`, error.message);
      
      const failCount = (modelFailCount.get(currentModel.name) || 0) + 1;
      modelFailCount.set(currentModel.name, failCount);
      
      if (error.message.includes('429') || error.message.includes('quota') || failCount >= 3) {
        console.log(`⚠️ Switching from ${currentModel.name} due to ${failCount} failures`);
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
  
  try {
    if (currentModel.type === 'gemini') {
      return await getGeminiResponse(userMessage, session, detectedLang, currentModel.name);
    } else if (currentModel.type === 'basic') {
      return getBasicResponse(userMessage, session, detectedLang);
    }
  } catch (error) {
    console.error(`❌ ${currentModel.name} failed:`, error.message);
    throw error;
  }
}

async function getGeminiResponse(userMessage, session, detectedLang, modelName) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured');
  }

  const model = genAI.getGenerativeModel({ model: modelName });
  
  let conversationContext = '';
  if (session.conversationHistory.length > 0) {
    conversationContext = '\n\nRECENT CONVERSATION:\n';
    session.conversationHistory.slice(-3).forEach(exchange => {
      conversationContext += `User: ${exchange.user}\nMeddy: ${exchange.bot}\n`;
    });
  }

  let languageInstruction = '';
  if (detectedLang === 'ceb') {
    languageInstruction = 'IMPORTANT: Respond in Bisaya/Cebuano language.';
  } else if (detectedLang === 'tl') {
    languageInstruction = 'IMPORTANT: Respond in Tagalog language.';
  } else {
    languageInstruction = 'IMPORTANT: Respond in English language.';
  }

  const prompt = `You are Meddy, a helpful assistant for Saint Joseph College Clinic. When introducing yourself or when appropriate, mention that you are Meddy, the clinic chatbot.

${languageInstruction}

CLINIC INFORMATION:

LOCATION:
- Main Campus Clinic: Ground Floor beside the Theology Office
- Dental Clinic: Junior High School Department, near the medical clinic

OPERATING HOURS:
- Monday–Friday: 8:30 AM – 12:00 NN, 1:30 PM – 5:30 PM
- College Clinic: Extended until 8:30 PM
- Saturday: 8:00 AM – 12:00 NN (half-day)
- Closed on Sundays and holidays

DENTIST SCHEDULE:
- Monday–Friday: 8:30–11:30 AM and 1:30–4:30 PM (10 extraction slots per session)
- Saturday: 8:00–11:30 AM (half-day)
- Anesthesia is FREE during tooth extraction

DOCTOR SCHEDULE:
- Tuesday, Wednesday, Thursday: 9:00 AM – 12:00 NN
- Outside doctor's hours: Students can still visit for basic care and first aid
- Serious cases receive referral slips to hospitals

TOOTH EXTRACTION PROCESS:
1. Go to Main Campus Clinic first
2. Get referral slip (issued same day)
3. Go to Dentist's Clinic at Junior High School Department
4. Bring referral slip for same-day extraction (subject to slot availability)
5. Follow post-care instructions after extraction
6. Parental consent required for minors

AVAILABLE MEDICINES (Over-the-counter, no prescription needed):
- Paracetamol, Dycolsen, Dycolgen, Loperamide, Erceflora, Antacid
- Limit: Maximum 2 medicines per person
- Parental consent required for minors
- Prescription medicines require valid doctor's prescription

MEDICAL CERTIFICATES:
- Issued for: School excuse, fever, asthma attacks, other verified illness
- Requirement: Valid medical reasons confirmed by clinic staff

HOSPITAL REFERRALS:
- Referral hospital: Dongon Hospital
- Emergency: Can go directly to hospital
- Regular treatment: Visit clinic first for documentation
- Refusal slip given when clinic cannot accommodate

EMERGENCY PROCEDURES:
- Inform teacher/staff → Escorted to clinic → First aid → Hospital referral if needed
- Handles: Injuries, fainting, fever, asthma attacks, other urgent conditions

OTHER SERVICES (ALL FREE for enrolled students):
- First aid treatment
- Chronic condition monitoring
- Hospital referrals
- Health counseling
- Preventive care tips

TALKING TO ADMIN:
- Students can type "talk to admin" or "speak to staff" to connect with clinic staff
- When admin mode is active, chatbot pauses automatically
- Chatbot reactivates after 15 minutes of staff inactivity

${conversationContext}

User: ${userMessage}

Respond in 2-4 sentences in ${detectedLang === 'ceb' ? 'Bisaya/Cebuano' : detectedLang === 'tl' ? 'Tagalog' : 'English'}. Be helpful, friendly, and use emojis appropriately. Base your answer ONLY on the clinic information above.`;

  const result = await model.generateContent(prompt);
  const response = await result.response;
  return response.text();
}

function getBasicResponse(userMessage, session, lang) {
  const lowerMsg = userMessage.toLowerCase();
  
  const responses = {
    en: {
      greeting: "👋 Hi! I'm Meddy, your clinic assistant. How can I help you today?",
      location: "📍 Main Campus Clinic: Ground Floor beside the Theology Office\n🦷 Dental Clinic: Junior High School Department\n\n🕐 Hours:\n• Mon-Fri: 8:30 AM–12:00 NN, 1:30 PM–5:30 PM\n• College Clinic: Extended until 8:30 PM\n• Saturday: 8:00 AM–12:00 NN (half-day)\n• Closed Sundays & holidays",
      hours: "🕐 Clinic Hours:\n• Monday-Friday: 8:30 AM – 12:00 NN, 1:30 PM – 5:30 PM\n• College Clinic: Extended until 8:30 PM\n• Saturday: 8:00 AM – 12:00 NN (half-day)\n• Closed on Sundays and holidays",
       doctor: "👨‍⚕️ Doctor's Schedule:\n- Tuesday, Wednesday, Thursday: 9:00 AM - 12:00 NN\n- Outside these hours, students can still visit for basic care.",
      dentist: "🦷 Dentist Schedule:\n- Mon-Fri: 8:30-11:30 AM & 1:30-4:30 PM\n- Saturday: 8:00-11:30 AM\n- 10 extraction slots per session\n- FREE anesthesia during extraction",
      medicines: "💊 Available Medicines (FREE):\n- Paracetamol, Dycolsen, Dycolgen, Loperamide, Erceflora, Antacid\n- Maximum 2 medicines per person\n- Parental consent required for minors",
      extraction: "🦷 Tooth Extraction Process:\n1. Visit Main Campus Clinic\n2. Get referral slip\n3. Go to Dental Clinic at Junior High School\n4. Anesthesia is FREE!",
      certificate: "📋 Medical certificates are issued for school excuses, fever, asthma attacks, and other verified illnesses.",
      emergency: "🚨 Emergency Procedure:\n1. Inform teacher/staff\n2. Get escorted to clinic\n3. Receive first aid\n4. Hospital referral if needed",
      referral: "🏥 Referral Hospital: Dongon Hospital\n- Emergency: Go directly\n- Regular: Visit clinic first for documentation",
      services: "✨ Other Services (ALL FREE for enrolled students):\n- First aid treatment\n- Chronic condition monitoring\n- Hospital referrals\n- Health counseling\n- Preventive care tips",
      default: "I'm here to help! Please ask me about:\n- Clinic location & hours\n- Doctor/dentist schedule\n- Medicines available\n- Tooth extraction\n- Medical certificates\n- Hospital referrals\n- Emergency procedures\n\nOr type 'talk to admin' to speak with clinic staff."
    },
    tl: {
      greeting: "👋 Kumusta! Ako si Meddy, ang clinic assistant. Paano kita matutulungan ngayon?",
      location: "📍 Main Campus Clinic: Ground Floor beside the Theology Office\n🦷 Dental Clinic: Junior High School Department\n\n🕐 Oras:\n• Lun-Biy: 8:30 AM–12:00 NN, 1:30 PM–5:30 PM\n• College Clinic: Extended hanggang 8:30 PM\n• Sabado: 8:00 AM–12:00 NN (half-day)\n• Sarado tuwing Linggo at holiday",
      hours: "🕐 Oras ng Clinic:\n• Lunes-Biyernes: 8:30 AM – 12:00 NN, 1:30 PM – 5:30 PM\n• College Clinic: Extended hanggang 8:30 PM\n• Sabado: 8:00 AM – 12:00 NN (half-day)\n• Sarado tuwing Linggo at holiday",    
       doctor: "👨‍⚕️ Schedule ng Doktor:\n- Martes, Miyerkules, Huwebes: 9:00 AM - 12:00 NN\n- Pwede pa rin bisitahin ang clinic para sa basic care.",
      dentist: "🦷 Schedule ng Dentista:\n- Lun-Biy: 8:30-11:30 AM & 1:30-4:30 PM\n- Sabado: 8:00-11:30 AM\n- 10 extraction slots per session\n- LIBRE ang anesthesia",
      medicines: "💊 Available na Gamot (LIBRE):\n- Paracetamol, Dycolsen, Dycolgen, Loperamide, Erceflora, Antacid\n- Maximum 2 gamot per tao\n- Kailangan ng consent ng magulang para sa menor de edad",
      extraction: "🦷 Proseso ng Tooth Extraction:\n1. Pumunta sa Main Campus Clinic\n2. Kumuha ng referral slip\n3. Pumunta sa Dental Clinic sa Junior High School\n4. Anesthesia ay LIBRE!",
      certificate: "📋 Ang medical certificate ay ibinibigay para sa school excuse, lagnat, asthma attack, at iba pang sakit.",
      emergency: "🚨 Emergency Procedure:\n1. Sabihin sa teacher/staff\n2. Ihahatid sa clinic\n3. Makakatanggap ng first aid\n4. Hospital referral kung kailangan",
      referral: "🏥 Referral Hospital: Dongon Hospital\n- Emergency: Diretso sa hospital\n- Regular: Bisitahin muna ang clinic",
      services: "✨ Ibang Services (LAHAT LIBRE para sa enrolled students):\n- First aid treatment\n- Monitoring ng chronic conditions\n- Hospital referrals\n- Health counseling\n- Preventive care tips",
      default: "Nandito ako para tumulong! Tanungin mo ako tungkol sa:\n- Clinic location & oras\n- Doctor/dentist schedule\n- Available na gamot\n- Tooth extraction\n- Medical certificates\n- Hospital referrals\n- Emergency procedures\n\nO i-type ang 'talk to admin' para makipag-usap sa clinic staff."
    },
    ceb: {
      greeting: "👋 Kumusta! Ako si Meddy, ang clinic assistant. Unsaon nako pagtabang nimo?",
      location: "📍 Main Campus Clinic: Ground Floor beside the Theology Office\n🦷 Dental Clinic: Junior High School Department\n\n🕐 Oras:\n• Lun-Biy: 8:30 AM–12:00 NN, 1:30 PM–5:30 PM\n• College Clinic: Extended hangtod 8:30 PM\n• Sabado: 8:00 AM–12:00 NN (half-day)\n• Sarado tuwing Domingo ug holiday",
      hours: "🕐 Oras sa Clinic:\n• Lunes-Biyernes: 8:30 AM – 12:00 NN, 1:30 PM – 5:30 PM\n• College Clinic: Extended hangtod 8:30 PM\n• Sabado: 8:00 AM – 12:00 NN (half-day)\n• Sarado tuwing Domingo ug holiday",   
      doctor: "👨‍⚕️ Schedule sa Doktor:\n- Martes, Miyerkules, Huwebes: 9:00 AM - 12:00 NN\n- Pwede gihapon moduaw sa clinic para sa basic care.",
      dentist: "🦷 Schedule sa Dentista:\n- Lun-Biy: 8:30-11:30 AM & 1:30-4:30 PM\n- Sabado: 8:00-11:30 AM\n- 10 extraction slots per session\n- LIBRE ang anesthesia",
      medicines: "💊 Available nga Tambal (LIBRE):\n- Paracetamol, Dycolsen, Dycolgen, Loperamide, Erceflora, Antacid\n- Maximum 2 ka tambal per tawo\n- Kinahanglan og consent sa ginikanan para sa menor de edad",
      extraction: "🦷 Proseso sa Tooth Extraction:\n1. Adto sa Main Campus Clinic\n2. Kuha og referral slip\n3. Adto sa Dental Clinic sa Junior High School\n4. Anesthesia LIBRE!",
      certificate: "📋 Ang medical certificate ihatag para sa school excuse, hilanat, asthma attack, ug uban pang sakit.",
      emergency: "🚨 Emergency Procedure:\n1. Sulti sa teacher/staff\n2. Dad-on sa clinic\n3. Makadawat og first aid\n4. Hospital referral kung kinahanglan",
      referral: "🏥 Referral Hospital: Dongon Hospital\n- Emergency: Direkta sa hospital\n- Regular: Duaw sa una sa clinic",
      services: "✨ Uban pang Services (LAHAT LIBRE para sa enrolled students):\n- First aid treatment\n- Monitoring ng chronic conditions\n- Hospital referrals\n- Health counseling\n- Preventive care tips",
      default: "Nandito ako para tumulong! Pangutana ko tungkol sa:\n- Clinic location & oras\n- Doctor/dentist schedule\n- Available na tambal\n- Tooth extraction\n- Medical certificates\n- Hospital referrals\n- Emergency procedures\n\nO i-type ang 'talk to admin' para makipag-usap sa clinic staff."
    }
  };

  const langResponses = responses[lang] || responses.en;

  if (/(hi|hello|hey|kumusta|kamusta|unsay sabay|pregunta|question|help)/i.test(lowerMsg)) {
    return langResponses.greeting;
  } 
  
  if (/(where|location|asa|saan|diin|located|clinic info)/i.test(lowerMsg)) {
    return langResponses.location;
  } 
  
  if (/(hours|time|schedule|oras|open|close|when open|sarado|bukas)/i.test(lowerMsg) && !/(doctor|dentist|doktor|dentista)/i.test(lowerMsg)) {
    return langResponses.hours;
  } 
  
  if (/(doctor|doktor|physician|visit doctor|makita doctor)/i.test(lowerMsg)) {
    return langResponses.doctor;
  } 
  
  if (/(dentist|dental|ngipon|bungo|dentista|tooth|gigi)/i.test(lowerMsg)) {
    return langResponses.dentist;
  } 
  
  if (/(medicine|gamot|tambal|drugs|medication)/i.test(lowerMsg)) {
    return langResponses.medicines;
  } 
  
  if (/(extraction|bunot|tanggal|extract|tooth extraction|ngipon)/i.test(lowerMsg)) {
    return langResponses.extraction;
  } 
  
  if (/(certificate|certify|cert|excuse)/i.test(lowerMsg)) {
    return langResponses.certificate;
  } 
  
  if (/(emergency|emerhensya|kadalian|urgent|accident|injury|injured)/i.test(lowerMsg)) {
    return langResponses.emergency;
  } 
  
  if (/(referral|hospital|ospital|dongon|refer)/i.test(lowerMsg)) {
    return langResponses.referral;
  }
  
  if (/(service|services|offer|other|what do you have|ano ang)/i.test(lowerMsg)) {
    return langResponses.services;
  }
  
  return langResponses.default;
}

function detectLanguageFallback(text) {
  const lowerText = text.toLowerCase();
  
  const bisayaWords = ['unsa', 'kanus-a', 'kanusa', 'unsaon', 'asa', 'naa', 'wala', 
                       'tambal', 'ngipon', 'doktor', 'dentista', 'maayo', 'salamat kaayo',
                       'kumusta', 'pila', 'libre', 'bayad', 'kinsa', 'ngano', 'diin'];
  
  const tagalogWords = ['kumusta', 'ako', 'ang', 'ng', 'sa', 'po', 'opo', 'salamat', 
                        'ano', 'kelan', 'kailan', 'paano', 'gamot', 'sakit', 'ngipin',
                        'magkano', 'libre', 'bayad', 'sino', 'saan'];
  
  const bisayaCount = bisayaWords.filter(word => lowerText.includes(word)).length;
  const tagalogCount = tagalogWords.filter(word => lowerText.includes(word)).length;
  
  if (bisayaCount >= 1) return 'ceb';
  if (tagalogCount >= 2) return 'tl';
  return 'en';
}

function handlePostback(senderId, postback) {
  const payload = postback.payload;
  const session = getUserSession(senderId);

  console.log('📍 Postback payload:', payload);

  if (session.adminMode) {
    updateAdminActivity(senderId);
    return;
  }

  // Reset conversation ended flag when user interacts with menu
  if (session.conversationEnded) {
    session.conversationEnded = false;
  }

  if (payload === 'MAIN_MENU') {
    session.menuLevel = 'main';
    sendMainMenu(senderId, 'en');
    return;
  }

  if (payload === 'TALK_TO_ADMIN') {
    enableAdminMode(senderId);
    updateAdminActivity(senderId);
    return;
  }

  const messageMap = {
    'CLINIC_INFO': 'Tell me about clinic location and hours',
    'DOCTOR_SCHEDULE': 'When is the doctor available?',
    'DENTAL_SERVICES': 'Tell me about dental services',
    'MEDICINES': 'What medicines are available?',
    'CERTIFICATES': 'How do I get a medical certificate?',
    'REFERRALS': 'Tell me about hospital referrals',
    'EMERGENCY': 'What should I do in an emergency?',
    'OTHER_SERVICES': 'What other services does the clinic offer?',
    'TOOTH_EXTRACTION': 'How do I get a tooth extraction?'
  };

  const simulatedMessage = messageMap[payload];
  if (simulatedMessage) {
    session.lastLang = 'en';
    handleMessage(senderId, { text: simulatedMessage });
  } else {
    sendMainMenu(senderId, 'en');
  }
}

function sendMainMenu(senderId, lang = 'en') {
  const session = getUserSession(senderId);
  
  if (session && session.adminMode) {
    return;
  }

  // Don't send menu if conversation has ended
  if (session && session.conversationEnded) {
    return;
  }

  let menuText;
  if (!session.hasIntroduced) {
    menuText = "🏥 *Saint Joseph College Clinic*\n👋 Hi! I'm Meddy, your clinic assistant!\n\nHow can I help you today?";
    session.hasIntroduced = true;
  } else {
    menuText = "How can I help you today?";
  }

  const quickReplies = [
    { title: "📍 Clinic Info", payload: "CLINIC_INFO" },
    { title: "👨‍⚕️ Doctor", payload: "DOCTOR_SCHEDULE" },
    { title: "🦷 Dentist", payload: "DENTAL_SERVICES" },
    { title: "💊 Medicines", payload: "MEDICINES" },
    { title: "📋 Certificates", payload: "CERTIFICATES" },
    { title: "🏥 Referrals", payload: "REFERRALS" },
    { title: "🚨 Emergency", payload: "EMERGENCY" },
    { title: "✨ Services", payload: "OTHER_SERVICES" },
    { title: "👨‍💼 Talk to Staff", payload: "TALK_TO_ADMIN" }
  ];

  const formattedReplies = quickReplies.map(item => ({
    content_type: "text",
    title: item.title,
    payload: item.payload
  }));

  const message = {
    text: menuText,
    quick_replies: formattedReplies
  };

  sendMessage(senderId, message);
}

function sendTypingIndicator(senderId, isTyping) {
  const action = isTyping ? 'typing_on' : 'typing_off';
  const token = getPageTokenForUser(senderId);
  
  axios.post(`https://graph.facebook.com/v18.0/me/messages`, {
    recipient: { id: senderId },
    sender_action: action
  }, {
    params: { access_token: token }
  }).catch(error => {
    if (error.response?.data?.error?.code !== 100) {
      console.error('⚠️ Typing indicator error:', error.message);
    }
  });
}

function sendTextMessage(senderId, text) {
  sendMessage(senderId, { text });
}

function sendMessage(senderId, message) {
  const token = getPageTokenForUser(senderId);
  
  axios.post(`https://graph.facebook.com/v18.0/me/messages`, {
    recipient: { id: senderId },
    message: message,
    messaging_type: 'RESPONSE'
  }, {
    params: { access_token: token }
  })
  .then(response => {
    console.log('✅ Message sent successfully');
  })
  .catch(error => {
    const errorData = error.response?.data?.error;
    const errorCode = errorData?.code;
    const errorSubcode = errorData?.error_subcode;
    
    if (errorCode === 100 && errorSubcode === 2018001) {
      console.log(`⚠️ User ${senderId} not reachable (blocked/deleted/unsubscribed)`);
      return;
    }
    
    if (errorCode === 100) {
      console.log(`⚠️ Cannot send to user ${senderId}: ${errorData?.message}`);
      return;
    }
    
    console.error('❌ Error sending message:', errorData || error.message);
  });
}

// Admin API endpoints
app.post('/admin/enable/:userId', (req, res) => {
  const userId = req.params.userId;
  enableAdminMode(userId, true);
  res.json({ success: true, message: `Admin mode enabled for user ${userId}` });
});

app.post('/admin/disable/:userId', (req, res) => {
  const userId = req.params.userId;
  disableAdminMode(userId, false);
  res.json({ success: true, message: `Admin mode disabled for user ${userId}` });
});

app.get('/admin/status/:userId', (req, res) => {
  const userId = req.params.userId;
  const session = userSessions.get(userId);
  
  if (!session) {
    res.json({ exists: false });
  } else {
    res.json({
      exists: true,
      adminMode: session.adminMode,
      lastAdminActivity: session.lastAdminActivity,
      lastLang: session.lastLang,
      conversationCount: session.conversationCount,
      conversationEnded: session.conversationEnded,
      pageId: session.pageId
    });
  }
});

app.get('/admin/sessions', (req, res) => {
  const sessions = [];
  for (const [userId, session] of userSessions.entries()) {
    sessions.push({
      userId,
      adminMode: session.adminMode,
      lastLang: session.lastLang,
      conversationCount: session.conversationCount,
      conversationEnded: session.conversationEnded,
      lastInteraction: new Date(session.lastInteraction).toISOString(),
      pageId: session.pageId
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
    console.log(`🔄 Manually switched to model: ${model.name}`);
    res.json({ success: true, currentModel: model });
  } else {
    res.status(400).json({ success: false, error: 'Invalid model index' });
  }
});

app.get('/', (req, res) => {
  const currentModel = getCurrentModel();
  const configuredPages = Object.keys(PAGE_TOKENS).filter(pageId => PAGE_TOKENS[pageId]);
  res.send(`✅ Meddy - Saint Joseph College Clinic Chatbot is running! 🏥🤖\n\nCurrent AI Model: ${currentModel.name} (${currentModel.type})\nRequests: ${requestCount}/${currentModel.maxRequests} this minute\nConfigured Pages: ${configuredPages.length}`);
});

app.get('/test-ai', async (req, res) => {
  const testMessage = req.query.message || 'When is the dentist available?';
  const lang = req.query.lang || 'en';
  
  try {
    const session = {
      conversationHistory: [],
      lastLang: lang
    };
    
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
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/test-models', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(400).json({
        success: false,
        error: 'GEMINI_API_KEY not configured'
      });
    }

    const response = await axios.get(
      'https://generativelanguage.googleapis.com/v1beta/models',
      {
        params: { key: GEMINI_API_KEY }
      }
    );
    
    const modelNames = response.data.models
      .filter(m => m.supportedGenerationMethods.includes('generateContent'))
      .map(m => ({
        name: m.name.replace('models/', ''),
        displayName: m.displayName,
        description: m.description
      }));
    
    res.json({
      success: true,
      availableModels: modelNames
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ ADD THIS NEW ENDPOINT HERE (after /test-models, before app.listen)
app.get('/test-gemini', async (req, res) => {
  const testMessage = req.query.message || 'What should I do if I have a toothache?';
  
  try {
    const session = {
      conversationHistory: [],
      lastLang: 'en'
    };
    
    const currentModel = getCurrentModel();
    console.log(`🧪 Testing with model: ${currentModel.name}`);
    
    if (currentModel.type !== 'gemini') {
      return res.json({
        success: false,
        error: 'Current model is not Gemini',
        currentModel: currentModel.name,
        modelType: currentModel.type,
        hint: 'Gemini might have failed. Check your API key or try /admin/switch-model/0'
      });
    }
    
    const response = await getGeminiResponse(testMessage, session, 'en', currentModel.name);
    
    res.json({
      success: true,
      model: currentModel.name,
      modelType: currentModel.type,
      userMessage: testMessage,
      geminiResponse: response,
      isGemini: true,
      note: 'This is how Gemini AI responds - should be conversational and natural'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      model: getCurrentModel().name,
      hint: 'Check your GEMINI_API_KEY in .env file'
    });
  }
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const currentModel = getCurrentModel();
  const configuredPages = Object.keys(PAGE_TOKENS).filter(pageId => PAGE_TOKENS[pageId]);
  
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`🤖 AI integration: ${GEMINI_API_KEY ? 'ENABLED ✅' : 'BASIC MODE ONLY ⚠️'}`);
  console.log(`🔧 Current AI Model: ${currentModel.name} (${currentModel.type})`);
  console.log(`⏱️  Rate limit: ${currentModel.maxRequests} requests per minute`);
  console.log(`📊 Available models: ${AI_MODELS.map(m => m.name).join(', ')}`);
  console.log(`📄 Configured Facebook Pages: ${configuredPages.length}`);
  configuredPages.forEach(pageId => {
    console.log(`   - Page ID: ${pageId} ✅`);
  });
  
  if (configuredPages.length === 0) {
    console.log(`⚠️  WARNING: No page tokens configured! Add PAGE_ACCESS_TOKEN_1 and PAGE_ACCESS_TOKEN_2 to your .env file`);
  }
});