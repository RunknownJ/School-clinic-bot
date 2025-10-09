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

// User session management
const userSessions = new Map();

function getUserSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      conversationHistory: [],
      lastIntent: null,
      lastLang: 'en',
      conversationCount: 0,
      lastInteraction: Date.now(),
      menuLevel: 'main'
    });
  }
  
  const session = userSessions.get(userId);
  session.lastInteraction = Date.now();
  session.conversationCount++;
  
  return session;
}

// Clean up old sessions (30 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of userSessions.entries()) {
    if (now - session.lastInteraction > 1800000) {
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

  try {
    sendTypingIndicator(senderId, true);
    console.log('User message:', text);

    if (!GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY not configured');
    }

    const geminiResponse = await getGeminiResponse(text, session);
    console.log('Gemini response:', geminiResponse);
    
    const lang = detectLanguageFallback(text);
    session.lastLang = lang;
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

async function getGeminiResponse(userMessage, session) {
  try {
    const model = genAI.getGenerativeModel({ model: 'models/gemini-2.5-flash' });
    
    let conversationContext = '';
    if (session.conversationHistory.length > 0) {
      conversationContext = '\n\nRECENT CONVERSATION:\n';
      session.conversationHistory.slice(-3).forEach(exchange => {
        conversationContext += `User: ${exchange.user}\nAssistant: ${exchange.bot}\n`;
      });
    }

    const prompt = `You are a helpful assistant for Saint Joseph College Clinic.

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

${conversationContext}

User: ${userMessage}

Respond in 2-4 sentences. Detect the language:
- If user uses Bisaya/Cebuano words (like "unsa", "kanus-a", "unsaon", "asa", "naa", "tambal", "ngipon"), respond in Bisaya/Cebuano
- If user uses Tagalog words (like "ano", "kelan", "gamot", "po"), respond in Tagalog
- Otherwise respond in English
Be helpful, friendly, and use emojis appropriately. Base your answer ONLY on the clinic information above.`;

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
                       'kumusta', 'pila', 'libre', 'bayad', 'kinsa', 'ngano'];
  
  const tagalogWords = ['kumusta', 'ako', 'ang', 'ng', 'sa', 'po', 'opo', 'salamat', 
                        'ano', 'kelan', 'kailan', 'paano', 'gamot', 'sakit', 'ngipin',
                        'magkano', 'libre', 'bayad', 'sino'];
  
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
  const lang = session.lastLang || 'en';

  console.log('Postback payload:', payload);

  // Handle back to main menu
  if (payload === 'MAIN_MENU') {
    session.menuLevel = 'main';
    sendMainMenu(senderId, lang);
    return;
  }

  // Create appropriate message based on payload
  const messageMap = {
    'CLINIC_INFO': {
      en: 'Tell me about clinic location and hours',
      tl: 'Sabihin sa akin ang lokasyon at oras ng clinic',
      ceb: 'Sultihi ko ang lokasyon ug oras sa clinic'
    },
    'DOCTOR_SCHEDULE': {
      en: 'When is the doctor available?',
      tl: 'Kailan available ang doktor?',
      ceb: 'Kanus-a available ang doktor?'
    },
    'DENTAL_SERVICES': {
      en: 'Tell me about dental services',
      tl: 'Sabihin ang tungkol sa dental services',
      ceb: 'Sultihi ko ang bahin sa dental services'
    },
    'MEDICINES': {
      en: 'What medicines are available?',
      tl: 'Anong gamot ang available?',
      ceb: 'Unsa nga tambal ang available?'
    },
    'CERTIFICATES': {
      en: 'How do I get a medical certificate?',
      tl: 'Paano makakuha ng medical certificate?',
      ceb: 'Unsaon pagkuha ug medical certificate?'
    },
    'REFERRALS': {
      en: 'Tell me about hospital referrals',
      tl: 'Sabihin ang tungkol sa hospital referral',
      ceb: 'Sultihi ko ang bahin sa hospital referral'
    },
    'EMERGENCY': {
      en: 'What should I do in an emergency?',
      tl: 'Ano gagawin sa emergency?',
      ceb: 'Unsa akong buhaton sa emergency?'
    },
    'OTHER_SERVICES': {
      en: 'What other services does the clinic offer?',
      tl: 'Anong iba pang serbisyo ng clinic?',
      ceb: 'Unsa pa nga serbisyo sa clinic?'
    },
    'TOOTH_EXTRACTION': {
      en: 'How do I get a tooth extraction?',
      tl: 'Paano magpabunot ng ngipin?',
      ceb: 'Unsaon pagpabunot ug ngipon?'
    }
  };

  const msgObj = messageMap[payload];
  if (msgObj) {
    const simulatedMessage = { text: msgObj[lang] || msgObj.en };
    handleMessage(senderId, simulatedMessage);
  } else {
    sendMainMenu(senderId, lang);
  }
}

// Send main menu
function sendMainMenu(senderId, lang = 'en') {
  const menuText = {
    en: "🏥 Saint Joseph College Clinic\n\nChoose a category below:",
    tl: "🏥 Saint Joseph College Clinic\n\nPumili ng kategorya:",
    ceb: "🏥 Saint Joseph College Clinic\n\nPili ug kategorya:"
  };

  const quickReplies = [
    {
      en: "📍 Clinic Info & Hours",
      tl: "📍 Info at Oras ng Clinic",
      ceb: "📍 Info ug Oras sa Clinic",
      payload: "CLINIC_INFO"
    },
    {
      en: "👨‍⚕️ Doctor's Schedule",
      tl: "👨‍⚕️ Schedule ng Doktor",
      ceb: "👨‍⚕️ Schedule sa Doktor",
      payload: "DOCTOR_SCHEDULE"
    },
    {
      en: "🦷 Dental Services",
      tl: "🦷 Dental Services",
      ceb: "🦷 Dental Services",
      payload: "DENTAL_SERVICES"
    },
    {
      en: "💊 Medicines",
      tl: "💊 Mga Gamot",
      ceb: "💊 Mga Tambal",
      payload: "MEDICINES"
    },
    {
      en: "📋 Medical Certificates",
      tl: "📋 Medical Certificate",
      ceb: "📋 Medical Certificate",
      payload: "CERTIFICATES"
    },
    {
      en: "🏥 Referrals & Hospitals",
      tl: "🏥 Referral at Hospital",
      ceb: "🏥 Referral ug Hospital",
      payload: "REFERRALS"
    },
    {
      en: "🚨 Emergency & First Aid",
      tl: "🚨 Emergency at First Aid",
      ceb: "🚨 Emergency ug First Aid",
      payload: "EMERGENCY"
    },
    {
      en: "✨ Other Services",
      tl: "✨ Iba Pang Serbisyo",
      ceb: "✨ Uban Pang Serbisyo",
      payload: "OTHER_SERVICES"
    }
  ];

  // Messenger has limit of 13 quick replies, we have 8 so we're good
  const formattedReplies = quickReplies.map(item => ({
    content_type: "text",
    title: item[lang] || item.en,
    payload: item.payload
  }));

  const message = {
    text: menuText[lang] || menuText.en,
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

// Health check endpoint
app.get('/', (req, res) => {
  res.send('Saint Joseph College Clinic Chatbot with Gemini AI is running! 🏥🤖');
});

// Test Gemini endpoint
app.get('/test-gemini', async (req, res) => {
  const testMessage = req.query.message || 'When is the dentist available?';
  
  try {
    const session = {
      conversationHistory: [],
      lastLang: 'en'
    };
    
    const response = await getGeminiResponse(testMessage, session);
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