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

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Saint Joseph College Clinic Information
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

// User session management with admin mode support
const userSessions = new Map();
const ADMIN_INACTIVE_TIMEOUT = 15 * 60 * 1000; // 15 minutes

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
      adminInactivityTimer: null
    });
  }
  
  const session = userSessions.get(userId);
  session.lastInteraction = Date.now();
  session.conversationCount++;
  
  return session;
}

// Enable admin mode for a user
function enableAdminMode(userId) {
  const session = getUserSession(userId);
  session.adminMode = true;
  session.lastAdminActivity = Date.now();
  
  // Clear any existing timer
  if (session.adminInactivityTimer) {
    clearTimeout(session.adminInactivityTimer);
  }
  
  console.log(`Admin mode ENABLED for user ${userId}`);
}

// Update admin activity timestamp
function updateAdminActivity(userId) {
  const session = userSessions.get(userId);
  if (session && session.adminMode) {
    session.lastAdminActivity = Date.now();
    
    // Clear existing timer
    if (session.adminInactivityTimer) {
      clearTimeout(session.adminInactivityTimer);
    }
    
    // Set new timer for auto-disable after 15 minutes
    session.adminInactivityTimer = setTimeout(() => {
      disableAdminMode(userId, true);
    }, ADMIN_INACTIVE_TIMEOUT);
    
    console.log(`Admin activity updated for user ${userId}`);
  }
}

// Disable admin mode for a user
function disableAdminMode(userId, autoDisabled = false) {
  const session = userSessions.get(userId);
  if (session && session.adminMode) {
    session.adminMode = false;
    session.lastAdminActivity = null;
    
    if (session.adminInactivityTimer) {
      clearTimeout(session.adminInactivityTimer);
      session.adminInactivityTimer = null;
    }
    
    console.log(`Admin mode DISABLED for user ${userId} ${autoDisabled ? '(auto)' : '(manual)'}`);
    
    // Notify user that chatbot is back
    if (autoDisabled) {
      const lang = session.lastLang || 'en';
      const reactivationMsg = {
        en: "🤖 Meddy is now active again! Feel free to ask me questions about the clinic, or type 'talk to admin' if you need to speak with a staff member.",
        tl: "🤖 Si Meddy ay aktibo na ulit! Magtanong ka tungkol sa clinic, o i-type ang 'talk to admin' kung kailangan mo ng staff.",
        ceb: "🤖 Si Meddy aktibo na usab! Pangutana ko bahin sa clinic, o i-type ang 'talk to admin' kung kinahanglan nimo ang staff."
      };
      
      sendTextMessage(userId, reactivationMsg[lang] || reactivationMsg.en);
      setTimeout(() => {
        sendMainMenu(userId, lang);
      }, 1000);
    }
  }
}

// Clean up old sessions (30 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of userSessions.entries()) {
    if (now - session.lastInteraction > 1800000) {
      if (session.adminInactivityTimer) {
        clearTimeout(session.adminInactivityTimer);
      }
      userSessions.delete(userId);
    }
  }
}, 300000);

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Receive messages
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

  // Check if user wants to talk to admin
  const talkToAdminKeywords = ['talk to admin', 'speak to admin', 'contact admin', 
                                'magsalita sa admin', 'makipag-usap sa admin',
                                'pakigsulti sa admin', 'gusto ko admin'];
  
  if (talkToAdminKeywords.some(keyword => text.toLowerCase().includes(keyword))) {
    enableAdminMode(senderId);
    
    const adminModeMsg = {
      en: "👨‍💼 Admin mode activated! A clinic staff member has been notified and will respond to you shortly. Meddy is now paused.\n\n(Meddy will automatically reactivate after 15 minutes of admin inactivity)",
      tl: "👨‍💼 Admin mode activated! Aabisuhan ang clinic staff at sasagutin ka nila. Si Meddy ay naka-pause na.\n\n(Si Meddy ay babalik pagkatapos ng 15 minuto ng walang admin activity)",
      ceb: "👨‍💼 Admin mode activated! Pahibaw-an ang clinic staff ug tubagon ka nila. Si Meddy gi-pause na.\n\n(Si Meddy mobalik human sa 15 minuto nga walay admin activity)"
    };
    
    sendTextMessage(senderId, adminModeMsg[session.lastLang] || adminModeMsg.en);
    
    // Set the inactivity timer
    updateAdminActivity(senderId);
    return;
  }

  // If admin mode is active, just update activity and let admin handle it
  if (session.adminMode) {
    updateAdminActivity(senderId);
    console.log(`Message from user ${senderId} in admin mode - chatbot paused`);
    return; // Don't respond with chatbot
  }

  try {
    sendTypingIndicator(senderId, true);
    console.log('User message:', text);

    if (!GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY not configured');
    }

    // Detect language from user's typed message
    const lang = detectLanguageFallback(text);
    session.lastLang = lang;

    const geminiResponse = await getGeminiResponse(text, session, lang);
    console.log('Gemini response:', geminiResponse);
    
    session.conversationHistory.push({
      user: text,
      bot: geminiResponse,
      timestamp: Date.now()
    });

    if (session.conversationHistory.length > 5) {
      session.conversationHistory = session.conversationHistory.slice(-5);
    }

    sendTypingIndicator(senderId, false);
    sendTextMessage(senderId, geminiResponse);

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

async function getGeminiResponse(userMessage, session, detectedLang) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
    
    let conversationContext = '';
    if (session.conversationHistory.length > 0) {
      conversationContext = '\n\nRECENT CONVERSATION:\n';
      session.conversationHistory.slice(-3).forEach(exchange => {
        conversationContext += `User: ${exchange.user}\nMeddy: ${exchange.bot}\n`;
      });
    }

    // Language instruction based on detected language
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
- Monday–Friday: 8:00 AM – 5:00 PM
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
- Students can type "talk to admin" or "speak to admin" to connect with clinic staff
- When admin mode is active, chatbot pauses automatically
- Chatbot reactivates after 15 minutes of admin inactivity

${conversationContext}

User: ${userMessage}

Respond in 2-4 sentences in ${detectedLang === 'ceb' ? 'Bisaya/Cebuano' : detectedLang === 'tl' ? 'Tagalog' : 'English'}. Be helpful, friendly, and use emojis appropriately. Base your answer ONLY on the clinic information above.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error('Gemini API Error:', error.message);
    throw error;
  }
}

// Fallback language detection
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

// Handle postbacks
function handlePostback(senderId, postback) {
  const payload = postback.payload;
  const session = getUserSession(senderId);

  console.log('Postback payload:', payload);

  // If admin mode is active, update activity
  if (session.adminMode) {
    updateAdminActivity(senderId);
    return; // Don't respond with chatbot in admin mode
  }

  // Handle back to main menu
  if (payload === 'MAIN_MENU') {
    session.menuLevel = 'main';
    sendMainMenu(senderId, 'en'); // Always English for menu
    return;
  }

  // Handle talk to admin
  if (payload === 'TALK_TO_ADMIN') {
    enableAdminMode(senderId);
    
    const adminModeMsg = "👨‍💼 Admin mode activated! A clinic staff member has been notified and will respond to you shortly. Meddy is now paused.\n\n(Meddy will automatically reactivate after 15 minutes of admin inactivity)";
    
    sendTextMessage(senderId, adminModeMsg);
    updateAdminActivity(senderId);
    return;
  }

  // Menu selections are always in English
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
    // Force English for menu selections
    session.lastLang = 'en';
    handleMessage(senderId, { text: simulatedMessage });
  } else {
    sendMainMenu(senderId, 'en');
  }
}

// Send main menu (always in English)
function sendMainMenu(senderId, lang = 'en') {
  const session = getUserSession(senderId);
  
  // Don't send menu if admin mode is active
  if (session && session.adminMode) {
    return;
  }

  const menuText = "🏥 Saint Joseph College Clinic\n👋 Hi! I'm Meddy, your clinic assistant!\n\nChoose a category below:";

  const quickReplies = [
    { title: "📍 Clinic Info & Hours", payload: "CLINIC_INFO" },
    { title: "👨‍⚕️ Doctor's Schedule", payload: "DOCTOR_SCHEDULE" },
    { title: "🦷 Dental Services", payload: "DENTAL_SERVICES" },
    { title: "💊 Medicines", payload: "MEDICINES" },
    { title: "📋 Medical Certificates", payload: "CERTIFICATES" },
    { title: "🏥 Referrals & Hospitals", payload: "REFERRALS" },
    { title: "🚨 Emergency & First Aid", payload: "EMERGENCY" },
    { title: "✨ Other Services", payload: "OTHER_SERVICES" },
    { title: "👨‍💼 Talk to Admin", payload: "TALK_TO_ADMIN" }
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

// Send typing indicator
function sendTypingIndicator(senderId, isTyping) {
  const action = isTyping ? 'typing_on' : 'typing_off';
  
  axios.post(`https://graph.facebook.com/v18.0/me/messages`, {
    recipient: { id: senderId },
    sender_action: action
  }, {
    params: { access_token: PAGE_ACCESS_TOKEN }
  }).catch(error => {
    console.error('Error sending typing indicator:', error.message);
  });
}

// Send text message
function sendTextMessage(senderId, text) {
  sendMessage(senderId, { text });
}

// Send message via Messenger API
function sendMessage(senderId, message) {
  axios.post(`https://graph.facebook.com/v18.0/me/messages`, {
    recipient: { id: senderId },
    message: message,
    messaging_type: 'RESPONSE'
  }, {
    params: { access_token: PAGE_ACCESS_TOKEN }
  })
  .then(response => {
    console.log('Message sent successfully');
  })
  .catch(error => {
    console.error('Error sending message:', error.response?.data || error.message);
  });
}

// Admin endpoint to manually enable admin mode
app.post('/admin/enable/:userId', (req, res) => {
  const userId = req.params.userId;
  enableAdminMode(userId);
  res.json({ success: true, message: `Admin mode enabled for user ${userId}` });
});

// Admin endpoint to manually disable admin mode
app.post('/admin/disable/:userId', (req, res) => {
  const userId = req.params.userId;
  disableAdminMode(userId, false);
  res.json({ success: true, message: `Admin mode disabled for user ${userId}` });
});

// Admin endpoint to check user status
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
      lastLang: session.lastLang
    });
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Meddy - Saint Joseph College Clinic Chatbot with Gemini AI is running! 🏥🤖');
});

// Test Gemini endpoint
app.get('/test-gemini', async (req, res) => {
  const testMessage = req.query.message || 'When is the dentist available?';
  
  try {
    const session = {
      conversationHistory: [],
      lastLang: 'en'
    };
    
    const response = await getGeminiResponse(testMessage, session, 'en');
    res.json({
      success: true,
      userMessage: testMessage,
      geminiResponse: response
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Check available models
app.get('/test-models', async (req, res) => {
  try {
    const response = await axios.get(
      'https://generativelanguage.googleapis.com/v1beta/models',
      {
        params: { key: GEMINI_API_KEY }
      }
    );
    
    const modelNames = response.data.models
      .filter(m => m.supportedGenerationMethods.includes('generateContent'))
      .map(m => m.name);
    
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Gemini AI integration: ${GEMINI_API_KEY ? 'ENABLED' : 'DISABLED - Add GEMINI_API_KEY to enable'}`);
});