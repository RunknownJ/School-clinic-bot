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
  name: 'Saint Joseph College',
  dentist: {
    weekdays: 'Mon-Fri: 8:30-11:30 AM (10 slots) & 1:30-4:30 PM (10 slots)',
    saturday: 'Sat: 8:00-11:30 AM (half-day)',
    sunday: 'Not available',
    extraction_process: 'Get referral from Main Campus clinic → Go to Junior High School dental office for tooth extraction'
  },
  doctor: {
    schedule: 'Tuesday, Wednesday, Thursday: 9:00 AM - 12:00 NN'
  },
  hospital: 'Dongon Hospital',
  medicines: {
    available: ['Paracetamol', 'Dycolsen', 'Dycolgen', 'Loperamide', 'Erceflora', 'Antacid'],
    note: 'Over-the-counter medicines, no prescription required'
  }
};

// System prompt for Gemini AI
const SYSTEM_PROMPT = `You are a helpful virtual assistant for Saint Joseph College School Clinic. Your role is to provide accurate information about clinic services in a friendly and professional manner.

CLINIC INFORMATION:
- Dentist Schedule: Monday-Friday 8:30-11:30 AM (10 slots) & 1:30-4:30 PM (10 slots), Saturday 8:00-11:30 AM
- Doctor Schedule: Tuesday, Wednesday, Thursday 9:00 AM - 12:00 NN
- Hospital Referral: Dongon Hospital
- Available Medicines: Paracetamol, Dycolsen, Dycolgen, Loperamide, Erceflora, Antacid (all over-the-counter, no prescription required)
- Medicine Limit: Maximum 2 medicines per person
- Parental Consent: Required for minors before dispensing medicine
- Medical Certificates: Issued for valid medical reasons (school excuse, fever, asthma attacks)
- All Services: FREE for enrolled students
- Anesthesia: FREE during tooth extraction

KEY POLICIES:
1. Dentist appointments are required (walk-ins accepted if slots available)
2. For tooth extraction: Get referral from Main Campus clinic → Go to Junior High School dental office for the extraction
3. Students can visit clinic for first aid/basic care even outside doctor's schedule
4. For emergencies, students can go directly to hospital or come to clinic for assessment
5. Refusal slips given when clinic cannot accommodate (full slots, requires specialized care, etc.)

RESPONSE GUIDELINES:
- Be concise and clear (2-4 sentences maximum unless complex question)
- Use emojis appropriately for warmth
- Detect language (English, Tagalog, or Bisaya/Cebuano) and respond in same language
- If question is outside clinic scope, politely redirect
- Always be helpful and empathetic
- Provide specific information based on the facts above

LANGUAGE DETECTION:
- English: Common words like "what", "when", "how", "can", "is"
- Tagalog: Words like "ano", "kelan", "paano", "po", "salamat", "gamot"
- Bisaya/Cebuano: Words like "unsa", "kanus-a", "unsaon", "asa", "naa", "tambal", "ngipon", "doktor"

INTENT CLASSIFICATION:
Classify user intent as one of: greeting, dentist_schedule, dentist_appointment, dentist_extraction, anesthesia, doctor_schedule, sick_no_doctor, emergency, medical_certificate, referral, medicines, medicine_limit, parental_consent, medicine_unavailable, refusal_slip, services, payment, thanks, help, off_topic

Format your response as JSON:
{
  "intent": "intent_name",
  "language": "en" or "tl" or "ceb",
  "response": "your helpful response here",
  "confidence": 0.0-1.0
}`;

// User session management
const userSessions = new Map();

function getUserSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      conversationHistory: [],
      lastIntent: null,
      lastLang: 'en',
      conversationCount: 0,
      lastInteraction: Date.now()
    });
  }
  
  const session = userSessions.get(userId);
  session.lastInteraction = Date.now();
  session.conversationCount++;
  
  return session;
}

// Clean up old sessions
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
    // Send typing indicator
    sendTypingIndicator(senderId, true);

    console.log('User message:', text);

    // Check if Gemini is configured
    if (!GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY not configured');
    }

    // Get response from Gemini
    const geminiResponse = await getGeminiResponse(text, session);
    
    console.log('Gemini response:', geminiResponse);
    
    // Detect language from user input
    const lang = detectLanguageFallback(text);
    
    // Update session
    session.lastLang = lang;
    session.conversationHistory.push({
      user: text,
      bot: geminiResponse,
      timestamp: Date.now()
    });

    // Keep only last 5 exchanges
    if (session.conversationHistory.length > 5) {
      session.conversationHistory = session.conversationHistory.slice(-5);
    }

    // Send typing indicator off
    sendTypingIndicator(senderId, false);

    // Send response
    sendTextMessage(senderId, geminiResponse);

    // Send follow-up menu
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
    // Use gemini-2.5-flash which is stable and available
    const model = genAI.getGenerativeModel({ model: 'models/gemini-2.5-flash' });
    
    // Build conversation context
    let conversationContext = '';
    if (session.conversationHistory.length > 0) {
      conversationContext = '\n\nRECENT CONVERSATION:\n';
      session.conversationHistory.slice(-3).forEach(exchange => {
        conversationContext += `User: ${exchange.user}\nAssistant: ${exchange.bot}\n`;
      });
    }

    const prompt = `You are a helpful assistant for Saint Joseph College Clinic.

CLINIC INFORMATION:
- Dentist Schedule: Monday-Friday 8:30-11:30 AM (10 slots) & 1:30-4:30 PM (10 slots), Saturday 8:00-11:30 AM
- Doctor Schedule: Tuesday, Wednesday, Thursday 9:00 AM - 12:00 NN
- Hospital Referral: Dongon Hospital
- Available Medicines: Paracetamol, Dycolsen, Dycolgen, Loperamide, Erceflora, Antacid (all over-the-counter, no prescription required)
- Medicine Limit: Maximum 2 medicines per person
- Parental Consent: Required for minors before dispensing medicine
- Medical Certificates: Issued for valid medical reasons (school excuse, fever, asthma attacks)
- All Services: FREE for enrolled students
- Anesthesia: FREE during tooth extraction

IMPORTANT POLICIES:
1. Dentist appointments required (walk-ins accepted if slots available)
2. TOOTH EXTRACTION PROCESS: Students must get a referral from the Main Campus clinic first, then go to the Junior High School dental office for the actual tooth extraction
3. Students can visit for first aid/basic care even outside doctor's schedule
4. For emergencies, go directly to hospital or come to clinic
5. Refusal slips given when clinic cannot accommodate

${conversationContext}

User: ${userMessage}

Respond in 2-4 sentences. Detect the language:
- If user uses Bisaya/Cebuano words (like "unsa", "kanus-a", "unsaon", "asa", "naa", "tambal", "ngipon"), respond in Bisaya/Cebuano
- If user uses Tagalog words (like "ano", "kelan", "gamot", "po"), respond in Tagalog
- Otherwise respond in English
Be helpful, friendly, and use emojis appropriately. Base your answer ONLY on the clinic information above.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    return text;
  } catch (error) {
    console.error('Gemini API Error:', error.message);
    throw error;
  }
}

// Fallback language detection
function detectLanguageFallback(text) {
  const lowerText = text.toLowerCase();
  
  // Bisaya/Cebuano words
  const bisayaWords = ['unsa', 'kanus-a', 'kanusa', 'unsaon', 'asa', 'naa', 'wala', 
                       'tambal', 'ngipon', 'doktor', 'dentista', 'maayo', 'salamat kaayo',
                       'kumusta', 'pila', 'libre', 'bayad', 'kinsa', 'ngano'];
  
  // Tagalog words
  const tagalogWords = ['kumusta', 'ako', 'ang', 'ng', 'sa', 'po', 'opo', 'salamat', 
                        'ano', 'kelan', 'kailan', 'paano', 'gamot', 'sakit', 'ngipin',
                        'magkano', 'libre', 'bayad', 'sino'];
  
  const bisayaCount = bisayaWords.filter(word => lowerText.includes(word)).length;
  const tagalogCount = tagalogWords.filter(word => lowerText.includes(word)).length;
  
  // Bisaya takes priority if detected
  if (bisayaCount >= 1) return 'ceb';
  if (tagalogCount >= 2) return 'tl';
  return 'en';
}

// Handle postbacks
function handlePostback(senderId, postback) {
  const payload = postback.payload;
  const session = getUserSession(senderId);
  const lang = session.lastLang || 'en';

  // Map payload to intent for Gemini context
  const intentMap = {
    'DENTIST': 'dentist_schedule',
    'DOCTOR': 'doctor_schedule',
    'MEDICINES': 'medicines',
    'REFERRAL': 'referral',
    'CERTIFICATE': 'medical_certificate',
    'SERVICES': 'services',
    'EMERGENCY': 'emergency',
    'PAYMENT': 'payment'
  };

  const intent = intentMap[payload] || 'help';
  
  // Create a message as if user asked about this topic
  const messageMap = {
    'DENTIST': lang === 'en' ? 'Tell me about dentist schedule' : 
               lang === 'tl' ? 'Ano ang schedule ng dentista' : 
               'Unsa ang schedule sa dentista',
    'DOCTOR': lang === 'en' ? 'Tell me about doctor schedule' : 
              lang === 'tl' ? 'Ano ang schedule ng doktor' : 
              'Unsa ang schedule sa doktor',
    'MEDICINES': lang === 'en' ? 'What medicines are available?' : 
                 lang === 'tl' ? 'Anong gamot ang available?' : 
                 'Unsa nga tambal ang available?',
    'REFERRAL': lang === 'en' ? 'Tell me about hospital referral' : 
                lang === 'tl' ? 'Paano ang hospital referral' : 
                'Unsaon ang hospital referral',
    'CERTIFICATE': lang === 'en' ? 'How do I get a medical certificate?' : 
                   lang === 'tl' ? 'Paano makakuha ng medical certificate?' : 
                   'Unsaon pagkuha ug medical certificate?',
    'SERVICES': lang === 'en' ? 'What services does the clinic offer?' : 
                lang === 'tl' ? 'Anong serbisyo ang inaalok ng clinic?' : 
                'Unsa nga serbisyo ang gi-offer sa clinic?',
    'EMERGENCY': lang === 'en' ? 'What should I do in an emergency?' : 
                 lang === 'tl' ? 'Ano gagawin sa emergency?' : 
                 'Unsa akong buhaton sa emergency?',
    'PAYMENT': lang === 'en' ? 'Do I need to pay for services?' : 
               lang === 'tl' ? 'May bayad ba ang mga serbisyo?' : 
               'Naa bay bayad sa mga serbisyo?'
  };

  const simulatedMessage = { text: messageMap[payload] || (lang === 'en' ? 'Help' : lang === 'tl' ? 'Tulong' : 'Tabang') };
  handleMessage(senderId, simulatedMessage);
}

// Send contextual menu based on intent
function sendContextualMenu(senderId, intent, lang = 'en') {
  // Don't send menu after thanks or off_topic
  if (['thanks', 'off_topic'].includes(intent)) {
    return;
  }

  const menus = {
    dentist_schedule: {
      en: ['🦷 Book Appointment', '💉 Anesthesia Info', '💊 Medicines'],
      tl: ['🦷 Mag-book', '💉 Anesthesia', '💊 Gamot'],
      ceb: ['🦷 Mag-book', '💉 Anesthesia', '💊 Tambal'],
      payloads: ['DENTIST_APPOINTMENT', 'ANESTHESIA', 'MEDICINES']
    },
    doctor_schedule: {
      en: ['📋 Med Certificate', '🏥 Referral', '🚨 Emergency'],
      tl: ['📋 Certificate', '🏥 Referral', '🚨 Emergency'],
      ceb: ['📋 Certificate', '🏥 Referral', '🚨 Emergency'],
      payloads: ['CERTIFICATE', 'REFERRAL', 'EMERGENCY']
    },
    medicines: {
      en: ['👨‍👩‍👧 Parental Consent', '🦷 Dentist', '👨‍⚕️ Doctor'],
      tl: ['👨‍👩‍👧 Pahintulot', '🦷 Dentista', '👨‍⚕️ Doktor'],
      ceb: ['👨‍👩‍👧 Pagtugot', '🦷 Dentista', '👨‍⚕️ Doktor'],
      payloads: ['PARENTAL_CONSENT', 'DENTIST', 'DOCTOR']
    },
    default: {
      en: ['🦷 Dentist', '👨‍⚕️ Doctor', '💊 Medicines', '🏥 Services'],
      tl: ['🦷 Dentista', '👨‍⚕️ Doktor', '💊 Gamot', '🏥 Serbisyo'],
      ceb: ['🦷 Dentista', '👨‍⚕️ Doktor', '💊 Tambal', '🏥 Serbisyo'],
      payloads: ['DENTIST', 'DOCTOR', 'MEDICINES', 'SERVICES']
    }
  };

  const menu = menus[intent] || menus.default;
  const titles = menu[lang] || menu['en'];
  const payloads = menu.payloads;

  const quickReplies = titles.slice(0, 4).map((title, index) => ({
    content_type: "text",
    title: title,
    payload: payloads[index]
  }));

  const followUpText = {
    en: "Need help with anything else?",
    tl: "May iba pa ba kayong kailangan?",
    ceb: "Naa pa bay lain nga imong kinahanglan?"
  };

  const message = {
    text: followUpText[lang] || followUpText.en,
    quick_replies: quickReplies
  };

  sendMessage(senderId, message);
}

// Send main menu
function sendMainMenu(senderId, lang = 'en') {
  const messages = {
    en: "How can I help you?",
    tl: "Paano kita matutulungan?",
    ceb: "Unsaon nako pagtabang nimo?"
  };
  
  const buttonLabels = {
    en: {
      dentist: "🦷 Dentist Info",
      doctor: "👨‍⚕️ Doctor Info",
      medicines: "💊 Medicines"
    },
    tl: {
      dentist: "🦷 Info ng Dentista",
      doctor: "👨‍⚕️ Info ng Doktor",
      medicines: "💊 Gamot"
    },
    ceb: {
      dentist: "🦷 Info sa Dentista",
      doctor: "👨‍⚕️ Info sa Doktor",
      medicines: "💊 Tambal"
    }
  };
  
  const labels = buttonLabels[lang] || buttonLabels.en;
  
  const response = {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text: messages[lang] || messages.en,
        buttons: [
          {
            type: "postback",
            title: labels.dentist,
            payload: "DENTIST"
          },
          {
            type: "postback",
            title: labels.doctor,
            payload: "DOCTOR"
          },
          {
            type: "postback",
            title: labels.medicines,
            payload: "MEDICINES"
          }
        ]
      }
    }
  };
  sendMessage(senderId, response);
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

// Test Gemini endpoint (for debugging)
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

// Add this endpoint to check available models
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